import { canonicalizeForAnchorMatch } from "../types/anchorText";
import { BANNED } from "../copy/rules";
import { narratorStructureLeaks } from "../copy/narratorStructure";
import { decodeEntities } from "../feeds/html";
import type { SourcedAct } from "../types/tapeSourcing";
import type { Voice } from "../types/spine";
import {
  MODE_CHAR_BANDS,
  containsContestedLanguage,
  hasDeclarativeSentence,
  isTapeSource,
  tapeDocIdFor,
  validateNarratedBeat,
  type EvidenceDoc as HeldEvidenceDoc,
  type IntroOnlyVerification,
  type NarratedBeat,
  type NarrationAttemptRecord,
  type NarrationMode,
  type Source,
  type SynthesisVerification,
  type TapeSource
} from "../types/narration";
import { splitSpokenSentences } from "../copy/spokenLine";
import type { EvidenceDoc, EvidenceGatherer, EvidencePack } from "./gatherEvidence";
import type {
  ActFrame,
  ActWriteRequest,
  ActWriteResult,
  BeatBrief,
  ClipBrief,
  GroundPageBrief,
  IntroKind,
  NarrationBuildContext,
  NarrationWriterBuilder,
  SeamBrief,
  SeamEditRequest,
  SeamNeighbour,
  SelectedClaim,
  WriterStreamEvent,
  WrittenSeam
} from "./NarrationWriterBuilder";
import type { ActSourceBrief, ActVerifyResult, NarrationVerifierBuilder, SeamVerdict, VerifyClipBrief, VerifySeamBrief } from "./NarrationVerifierBuilder";
import { scriptIsAboutPurpose } from "./StubNarrationVerifierBuilder";
import {
  actBeatsInOrder,
  assignSeamMode,
  clipDurationSec,
  clipOpening,
  decideIntro,
  introNamesShow,
  introNamesSource,
  introOnlyFirstSeam,
  introRestatesClip,
  planActSeams,
  seamBand,
  seamMode,
  type SeamClip,
  type SeamPlan,
  type SeamRest
} from "./actSeams";
import { pageDocIdFor } from "./synthesisVerify";
import { prepareSpecificsSources, unsupportedSpecificsInScript, type PreparedSources, type SpecificsMode } from "./specifics";
import { voiceGateEnforces, voiceReport, type VoiceGate } from "./voiceChecks";
import type { SentencePolicy, UnverifiedSeamPolicy } from "./gateConfig";
import { withCallContext } from "./runLog";
import {
  decideConnectiveNarration,
  decodeClaimEntities,
  evidenceBeatFor,
  gateSelectedClaims,
  HANDOFF_MODE,
  HANDOFF_SCRIPT,
  heldDocsOf,
  looksLikeSlug,
  NARRATION_PAGE_ATTEMPTS,
  retryNoteFrom,
  slotNeighbours,
  sourcesFor,
  type ActRoundPolicy,
  type NarrationWriteStats,
  type PendingPage,
  type SeamCheckedEvent,
  type WrittenAct,
  type WrittenBeat,
  type WrittenSlot
} from "./writeNarration";

/**
 * Q-03 — NARRATION WRITTEN PER ACT, VERIFIED PER BEAT
 * (docs/curation/listening-quality-plan.md; ledger F-95, F-97).
 *
 * Wyatt, 2026-09-12, after listening: "The AI narration script was super
 * clunky. It seems the focus is definitely on explicitly hitting all the
 * beats rather than telling a smooth, cohesive story." The measured cause
 * (deck §1): one page per beat, verified per page, with no stage that ever
 * read two adjacent pages together — so cohesion was not a property any
 * stage optimised, and a page rewritten three times to satisfy its purpose
 * got more literal each time.
 *
 * THE CONTRACT. One writer call per act: the whole act's verified material
 * — its clips (opening text, guest and show), its documents, its beats
 * with their claims — laid out in play order as SEAMS (`actSeams.ts`), and
 * back comes continuous prose, one script per seam: the Intro before each
 * clip (Q-02), the bridges between clips, and the argument the act
 * carries, in one voice. The beats are the checklist the prose must
 * carry, not the template it fills. Then ONE verifier call: each BEAT's
 * claim is checked against the act's prose and the clips, and each seam's
 * statements against the act's sources. A beat the prose does not carry
 * comes back as a NOTE naming it and its claim, and the retry hands the
 * writer the act again — its previous scripts and the notes — to EDIT,
 * not a page to rewrite. Three rounds per act at most.
 *
 * F-97 — WHAT RUN 9 TAUGHT, AND WHAT CHANGED. The first live run of this
 * contract (run 9, 2026-09-12) did not converge: `firstAttemptPassRate`
 * 0.048, eight of twenty-one pages unverified, 4.25 narration calls per
 * act, a clean Intro dropped because the ACT was sent back for other
 * seams. The shape was right (21 pages for 24 seams, `introRestates` 0);
 * the verification was not. Every refusal in the log was a per-PAGE rule
 * applied per SEAM: "a page with no sources may only ask a question"
 * (F-36/F-37), "a Patch must select at least one claim" (§4.7 rule 1),
 * "not supported by the source attached to it". Per-act prose naturally
 * bridges — the seam after a clip restates what the clip established
 * (supported by THAT window, attached to a different seam) and sets up
 * the next — and seam-scoped source attachment made that unsupported by
 * construction. So, three things:
 *
 *   1. SUPPORT IS ACT-SCOPED. The act has ONE source set (`actSources`):
 *      every gated claim of every seam, every clip's transcript window,
 *      and the verified pages of earlier acts (F-88's ground). A seam's
 *      statements may rest on any of it. The mechanical gate evaluates a
 *      seam against that set (`actSourceCount`), and the seam's `sources`
 *      are what the VERIFIER answers it rests on (`restsOn`) — not what
 *      the writer declared. F-36/F-37 becomes: a seam that states
 *      something about the world must rest on at least one act source.
 *   2. THE MODE IS ASSIGNED AFTER WRITING (`assignSeamMode`), from what
 *      the seam rests on — Patch on print, Frame on tape into a clip,
 *      Hinge on tape or nothing after the last clip, Intro with no beat
 *      — never before as a contract the writer must hit. §4.7 rule 1
 *      applies to the BEAT: the act's prose somewhere carries its claim
 *      with support; the seam that carries it need not be a Patch.
 *   3. THE RETRY EDITS ONLY WHAT FAILED. A seam that cleared the rules and
 *      was confirmed by the verifier is FROZEN: the writer is told to
 *      return it verbatim and the orchestrator keeps its text whatever
 *      comes back; the verifier re-checks only the seams that changed and
 *      the beats they carry. A clean Intro is never dropped for another
 *      seam's failure. The verifier runs every round something clean and
 *      unconfirmed exists — a mechanical refusal of one seam no longer
 *      keeps the others waiting three rounds for their first judgement.
 *
 * WHAT DID NOT CHANGE. A quote is a span of a held document or the script
 * is spent (`gateSelectedClaims`), attribution is read off the document
 * (`sourcesFor`), the structural validator (`validateNarratedBeat`) with
 * the seam's own band, the slug guard, F-45's negative-record rule (now
 * quoting the sentence), and Q-02's Intro rules in code. What counts as
 * verified is F-51's: sources proven in code, judged by a separate
 * verifier. F-88's post-pass is untouched.
 *
 * WHERE THE PAGES GO. One page per seam, recorded without changing the
 * item model: on the seam's first narration beat (`WrittenBeat.narration`)
 * — its other narration beats point at it (`carriedBy`) and hold no page —
 * or, for a seam with no beats, as the clip's `connectiveNarration` in
 * mode `Intro`. `stitchAct` walks the beats exactly as before and emits
 * one narration item per seam. The beat list comes out as it went in.
 *
 * FAILURE POLICY, F-51's, at the seam. A seam the verifier never confirmed
 * keeps its last mechanically clean draft with `verified: false` and the
 * final objection; a seam whose positioned beat was never carried keeps
 * its confirmed text unverified with the beat named; a seam that never
 * once cleared the mechanical rules keeps the `no-page` hand-off; an
 * intro-only seam that FAILED three times is dropped and the clips run
 * together (silence is a valid bridge, §4.8) — a clean one is kept.
 * `unverifiedPages` counts the kept ones and the gate refuses on any.
 * GV-108: under FORAY_UNVERIFIED_SEAM_POLICY=cut (default `keep`, the policy
 * above) a seam the verifier never confirmed keeps only its introduction
 * sentences, checked in code, or is dropped; nothing unverified and no
 * hand-off line is kept (`cutToIntroduction`).
 *
 * GV-113 (W5-11; R2-10, MQ-11): under FORAY_UNSUPPORTED_SENTENCE_POLICY=cut
 * (default `rewrite`, the policy above) a seam whose per-sentence verdicts
 * mark some, but not all, of its statements unsupported is not sent back:
 * code removes those sentences and confirms the rest in the same round
 * (`cutUnsupportedSentences`). Only a beat the cut leaves uncarried re-opens
 * a seam, for exactly one more writer round (`holdOrphanEdits`).
 *
 * COST. A clean act is two requests (write, verify). A round is at most
 * two more (the writer, then the verifier if anything clean is
 * unconfirmed), so an act costs at most six. The deck's target —
 * `narrationCallsPerAct` ≤ 3 — is met on a clean pass.
 *
 * F-99 — THE TWO THINGS THE SOURCING PASS LEFT HERE (F-96's PR named
 * both). Neither is a new rule; both are this lane consuming a field §4.5
 * now sets.
 *
 *   A. A MERGED CLIP IS ONE CLIP. §4.5 merges a second beat whose thought
 *      sits in the same stretch of the same episode into the clip before
 *      it (`SourcedBeat.mergedInto`): the clip is extended forward and
 *      both beats resolve to ONE segment pointer. `stitchAct` and the
 *      partial projection already play that segment once; `planActSeams`
 *      now lays it out once too, as one `SeamClip` carrying both beats
 *      (`SeamClip.carries`, printed as "carries beats b2, b3" on the CLIP
 *      line). One Intro, one bridge in, one bridge out, and the verifier
 *      judges both beats against the one window — instead of two Intros
 *      and a beatless seam between two plays of the same tape.
 *   B. A SEED-LOST BEAT IS CARRIED ONLY AS FAR AS THE SOURCES GO. A beat
 *      G-25 seeded from a transcript §4.5 could not place carries
 *      `seedLost: true` (F-96). Its claim names a guest and an incident
 *      the act has no tape and no print for — unverifiable by
 *      construction, and six of run 9's eight unverified pages. The
 *      writer is told, on the beat's own line, to carry it only as far as
 *      the act's sources support it and never to attribute specifics to
 *      the people it names; the verifier is told not to demand the seed's
 *      specifics. And when the act's sources cannot reach it at all, the
 *      beat is CLOSED after its first judgement — reported
 *      `uncarried: seed-lost` on the page (`unverifiedReason:
 *      "seed-lost"`, counted as `seedLostBeats`) instead of sending the
 *      act back twice more for a note no writer can answer. F-97's doubt
 *      (c) said the honest fix is at seeding; this stops the retry tax
 *      until it lands.
 */

export interface WriteActOptions {
  writer: NarrationWriterBuilder;
  verifier: NarrationVerifierBuilder;
  evidence: EvidenceGatherer;
  stats?: NarrationWriteStats;
  segmentSources?: ReadonlyArray<{ id: string; show: string; title: string }>;
  /** F-97: F-88's ground — the verified pages of the acts already landed. */
  ground?: ReadonlyArray<GroundPageBrief>;
  /**
   * Q-09: the shows this Foray has ALREADY named, from the acts before this
   * one. Foray-wide, like `ground` and for the same reason — the listener's
   * memory does not reset at an act boundary, and a show introduced in act 1
   * does not need introducing again in act 3.
   *
   * Omitted means "none yet", which is what act 1 passes and what every
   * caller that does not care passes. Acts are narrated concurrently (G-32),
   * so nothing is carried from one act's narration to the next: `runPipeline`
   * computes every act's set up front from the sourced acts
   * (`showsHeardBeforeEachAct` in writeNarration.ts, gen-8) and
   * `writeNarration` hands each act its own.
   */
  showsIntroduced?: ReadonlyArray<string>;
  /**
   * GV-34 (W5-10): the `specifics` gate (FORAY_SPECIFICS_CHECK, threaded from
   * the run's `GateConfig`). Only `enforce` does anything here: every
   * sentence of a seam is checked against the act's source texts — every
   * gated claim's quote, every clip's transcript window, every ground page —
   * and a year, figure or name none of them carries is a mechanical issue,
   * so the writer is re-asked. `report` (the default) and `off` leave the
   * act exactly as before; the metric is computed from the finished pages
   * (`veracityMetrics.ts`), not here.
   */
  specifics?: SpecificsMode;
  /**
   * GV-104 (W5-18): the voice gate (FORAY_VOICE_GATE and
   * FORAY_VOICE_ENFORCE_FROM_ACT, threaded from the run's `GateConfig`).
   * Only `enforce` does anything here, and only on an act at position
   * `enforceFromAct` or later (`ctx.actIndex`, else `actIndex`, else 0):
   * every sentence of a seam goes through spokenLine.js's spoken-line rules
   * (N7-N9) and N24's numeric cap (`voiceReport().hardErrors`), and a finding
   * is a mechanical issue, so the seam is re-asked. Sentence shape and the
   * reading grade never gate. Omitted, `report` and `off` leave the act
   * exactly as before.
   */
  voiceGate?: VoiceGate;
  /**
   * GV-38 (W4-08): the act frame, sent on every round's request. Absent
   * (the default driver) means the request carries no `frame` key at all.
   */
  frame?: ActFrame;
  /**
   * GV-73 (W4-10; R1-06, R1-01, GP-05): write the act through the writer's
   * streamed reply (`writeActStream`), checking each seam as its line closes.
   * Applies only when the writer implements the method; omitted or false is
   * today's one-shot `writeAct`, byte for byte. Set from FORAY_WRITER_STREAM
   * (or the fast-path umbrella) by the driver. See `streamRound`.
   */
  streamSeams?: boolean;
  /** GV-73: this act's position in the Foray, for `onSeamChecked`. Default 0. */
  actIndex?: number;
  /**
   * GV-73: fired once per seam released early on the streamed path. A
   * signal for the delivery workstream (R1-15), not permission to play: the
   * act-level pass below stays the authority, and per-item serving waits for
   * the per-act veracity gate. A throwing callback is logged, never fatal.
   */
  onSeamChecked?: (event: SeamCheckedEvent) => void;
  /**
   * GV-73: the most the streamed reply may go without a single event before
   * it is treated as stalled and cut like a token-cap stop (finished seams
   * kept, the rest re-asked). An IDLE bound, between events, so a long
   * healthy stream is never cut for its total length. Default
   * `DEFAULT_WRITER_STREAM_IDLE_MS`.
   */
  streamIdleTimeoutMs?: number;
  /**
   * GV-80 (W4-13): the act's round policy (`roundPolicyFor` in
   * writeNarration.ts). `maxRounds` bounds the round loop; `editScope:
   * "seams"` sends round 2 onwards as a seam edit (`editSeams`) when the
   * writer offers one -- only the failing seams, their neighbours, the clips
   * they touch and the documents they cite -- and a whole-act round when it
   * does not. Omitted is today's policy: `NARRATION_PAGE_ATTEMPTS` whole-act
   * rounds, byte for byte.
   */
  roundPolicy?: ActRoundPolicy;
  /**
   * GV-108 (W5-12b; R2-13): what a seam the verifier never confirmed leaves
   * behind (FORAY_UNVERIFIED_SEAM_POLICY, threaded from the run's
   * `GateConfig`). Omitted or `keep` is F-51's policy, byte for byte (see
   * FAILURE POLICY above). `cut` keeps only the seam's introduction
   * sentences, checked in code (`cutToIntroduction`), as a verified `Intro`
   * page on the clip it introduces, or drops the seam: its narration beats
   * record `droppedReason: "unverified-cut"` and the clips run together.
   * The hand-off line (HANDOFF_SCRIPT) is never produced under `cut`.
   */
  unverifiedSeamPolicy?: UnverifiedSeamPolicy;
  /**
   * GV-113 (W5-11; R2-10, MQ-02, MQ-11): what a seam whose per-sentence
   * verdicts (`SeamVerdict.sentences`, GV-51) mark some, but not all, of its
   * statement sentences `unsupported` costs (FORAY_UNSUPPORTED_SENTENCE_POLICY,
   * threaded from the run's `GateConfig`). Omitted or `rewrite` is today's
   * policy, byte for byte: the seam is refused and the writer re-asked. `cut`
   * removes those sentences in code (`cutUnsupportedSentences`): the trimmed
   * seam, re-validated with seamBand's floor relaxed, is confirmed in the same
   * round at no writer cost, and its page lists the removed sentences as
   * `cutSentences`. A beat the cut leaves uncarried re-opens the seam for
   * exactly ONE more writer round; after it the trimmed text stands and the
   * beat's fate is the unverified-seam policy's (GV-108). Every statement
   * unsupported, an unconfirmed statement surviving, or a trimmed seam that
   * fails a rule takes the rewrite path. A seam released early on the
   * streamed path is never cut (it may already be playing).
   */
  sentencePolicy?: SentencePolicy;
  /**
   * GV-110 (W7-09; R2-17): the bench-only writer exchange recorder. Called
   * once per round, at the end of the round (after the mechanical gate and
   * the verifier), with what the writer was sent, what it returned, the
   * round's mechanical issues and the verifier's verdict. A callback only:
   * this module never writes it anywhere (the CLI's `--record-exchanges`
   * does, under data-local/, for bench prompts only). Omitted (the default)
   * means nothing is built or called, byte for byte. A throwing callback is
   * logged, never fatal.
   */
  onExchange?: (exchange: WriterExchange) => void;
}

/**
 * GV-110: one writer round, as the recorder sees it. `request` is exactly
 * what the writer was sent and `reply` exactly what it returned: on a whole-
 * act round (`call` `writeAct`, or `writeActStream` on the streamed path, whose
 * reply is the seams that arrived) an `ActWriteRequest`; on a GV-80 seam-edit
 * round (`editSeams`) the shorter `SeamEditRequest` and the edited seams only.
 * `mechanical` is the round's mechanical gate, as `replayMechanicalGate`
 * re-derives it from a recorded whole-act round 1. `verdict` is the verifier's
 * answer, absent on a round where no seam changed (no verifier call).
 */
export type WriterExchange = {
  actTitle: string;
  round: number;
  reply: ActWriteResult;
  mechanical: string[];
  verdict?: ActVerifyResult;
} & ({ call: "writeAct" | "writeActStream"; request: ActWriteRequest } | { call: "editSeams"; request: SeamEditRequest });

/**
 * GV-73: the default idle bound on a streamed act reply -- the same 120 s
 * the OpenAI-compatible provider allows a whole one-shot call
 * (`chat/openAICompatProvider.ts`), here allowed between two events, which
 * also covers the prompt's prefill before the first seam.
 */
export const DEFAULT_WRITER_STREAM_IDLE_MS = 120_000;

/**
 * GV-73: an optional per-seam check a verifier MAY offer (the verification
 * workstream's; no verifier implements it yet). On the streamed path a seam
 * that carries claims or beats is released early only when this confirms it
 * against the act sources that have arrived so far; without it, such a seam
 * waits for the act's verifier like every other seam.
 */
export interface SeamVerifyRequest {
  actTitle: string;
  voice: Voice;
  seam: VerifySeamBrief;
  /** The beats positioned in this seam. */
  beats: BeatBrief[];
  clips: VerifyClipBrief[];
  /** The act's sources so far: the clips' windows, the ground and the gated
   * claims of the seams already arrived. */
  sources: ActSourceBrief[];
  documents: EvidenceDoc[];
  ground?: GroundPageBrief[];
}
export interface SeamVerifyResult {
  confirmed: boolean;
  notes?: string;
}
export type SeamVerifyingVerifier = NarrationVerifierBuilder & {
  verifySeam?(request: SeamVerifyRequest, ctx: NarrationBuildContext): Promise<SeamVerifyResult>;
};

/** GV-73: why a streamed reply stopped short, as the note each missing seam gets. */
interface StreamCut {
  note: string;
}

/** GV-73: the issue a seam the writer never reached gets after a token-cap stop. */
export const UNFINISHED_AT_CAP_NOTE = "unfinished: the writer stopped at its token cap";

interface ClipState {
  plan: SeamClip;
  brief: ClipBrief;
  windowText: string;
  window?: EvidenceDoc;
}

interface SeamState {
  plan: SeamPlan;
  band: [number, number];
  intro?: IntroKind;
  /** The gate's view of the seam: the act's documents, the beats' claims
   * as the purpose text (F-46), tape citable whatever the mode, and no
   * per-page claim quota (`claimsOptional`). */
  gate: PendingPage;
  attempts: NarrationAttemptRecord[];
  /** The current mechanically clean script with its gated claims. */
  draft?: {
    script: string;
    claims: SelectedClaim[];
    page: NarratedBeat;
    hints: NarratedBeat["pronunciationHints"];
    /** GV-113: the writer's sentences this draft was trimmed of as
     * unsupported, in order, and the round the cut was made in. */
    cut?: { sentences: string[]; round: number };
  };
  /** True when the draft is new or edited this round — the verifier
   * judges it; false for a frozen seam or one the writer left alone. */
  changed: boolean;
  /** The verifier's confirmation: what the seam rests on, as sources. */
  confirmed?: { sources: Source[]; rest: SeamRest; pageIds: string[]; notes?: string; round: number };
  /** Frozen: confirmed and untouched — the writer returns it verbatim. */
  frozen: boolean;
  /** The last draft that cleared every mechanical rule — F-51's salvage. */
  kept?: { page: NarratedBeat; notes?: string };
  /** The last page produced at all, mechanically clean or not. */
  lastPage?: NarratedBeat;
  /** The previous round's script, handed back for editing. */
  previousScript?: string;
  /** What is wrong with this seam, for the next round's brief. */
  notes?: string;
  /** True for a seam that returned an empty script and may (no beats,
   * intro not full) — no page, silence bridges. */
  silent?: boolean;
  /**
   * GV-73: released early on the streamed path -- checked as its line
   * closed and signalled (`onSeamChecked`), so it may already be on its way
   * to the listener. It is judged with the act in the round it was released
   * in and is never edited afterwards (frozen from the end of that round),
   * whatever the verifier says.
   */
  released?: { round: number; atMs: number; verifiedBy: "code" | "verifier" };
  /**
   * GV-113: the one writer round a sentence cut that orphaned a beat earned
   * this seam: the round of the cut, the trimmed, confirmed state it left,
   * and the beats that state carried. If the seam is not confirmed at the
   * end of the next round, that state is put back and stands
   * (`holdOrphanEdits`). Set once; a second orphaning earns nothing.
   */
  orphanEdit?: {
    round: number;
    state: Pick<SeamState, "draft" | "confirmed" | "kept" | "lastPage" | "previousScript">;
    carried: Array<Pick<BeatState, "carriedBy" | "restsOn" | "verifiedAtAttempt"> & { beatId: string }>;
  };
}

interface BeatState {
  brief: BeatBrief;
  seamId: string;
  carried: boolean;
  carriedBy?: string;
  restsOn?: string[];
  verifiedAtAttempt?: number;
  notes?: string;
  /**
   * F-99: a `seedLost` beat the act's sources could not reach, CLOSED on
   * the verifier's first refusal of it. It is not carried and never will
   * be — the tape its claim was written from is not in the Foray — so it
   * leaves the checklist, stops appearing in the round's notes, and does
   * not keep its seam open for two more rounds. The page it belongs to
   * says so (`unverifiedReason: "seed-lost"`).
   */
  seedLostClosed?: true;
  /**
   * GV-113: the round a sentence cut left this beat uncarried in. It earns
   * its seam ONE more writer round; from the round after, while it stays
   * uncarried, it is no note and keeps no seam open (`orphanSpent`), and the
   * page names it as not carried.
   */
  orphanedAt?: number;
}

/** One entry of the act's source set, with what it resolves to. */
interface ActSource {
  brief: ActSourceBrief;
  /** A claim's or a clip's source shape; absent for a ground page. */
  source?: Source;
  /** GV-113: a claim's index in its seam's `draft.claims`. */
  claimIndex?: number;
  /** A ground page's Foray-wide id. */
  pageId?: string;
}

/**
 * Q-09: the key a show is remembered by — the same canonicalisation the
 * Intro's own naming check uses (`introNamesShow` through
 * `canonicalizeForAnchorMatch`), so "Practical AI" and "practical ai" are
 * one show and the set cannot disagree with the checker about whether the
 * name was said.
 */
export function canonicalShowKey(show: string): string {
  return canonicalizeForAnchorMatch(show ?? "").trim();
}

/**
 * Q-09: whether this clip is the first from its show, recording that the
 * show has now been heard. A clip whose show is not on record (no
 * catalogue or registry row) is `true` — the stricter answer — and the
 * naming rule is waived for it separately, on `nameable`.
 */
function noteShowHeard(heard: Set<string>, show: string): boolean {
  const key = canonicalShowKey(show);
  if (key.length === 0) return true;
  if (heard.has(key)) return false;
  heard.add(key);
  return true;
}

export async function writeActNarration(act: SourcedAct, options: WriteActOptions, voice: Voice, ctx: NarrationBuildContext): Promise<WrittenAct> {
  const { writer, verifier, evidence, stats } = options;
  if (!writer.writeAct || !verifier.verifyAct) {
    throw new Error("writeActNarration: the writer and verifier must both offer the per-act contract (writeAct / verifyAct)");
  }
  const ground = options.ground ?? [];
  /* GV-104: whether this act's seams answer to the voice rules in code. */
  const voiceEnforce = voiceEnforcedFor(options, ctx);

  /* 1. THE ACT'S EVIDENCE, through the same builder the prefetch used
        (`evidenceBeatFor`), so every gather here is a memo hit (G-35).
        Every tape beat is gathered — the Intro decision and the restate
        check need the clip's window even where the per-page path wanted
        no Frame. */
  const packs = new Map<string, EvidencePack>();
  const beatsInOrder = actBeatsInOrder(act);
  await Promise.all(
    beatsInOrder.map(async ({ slot, beat, sourced }) => {
      const s = act.slots[slot]!;
      const mode: NarrationMode = sourced.sourcing === "narration" ? sourced.narration.mode : (decideConnectiveNarration(s, beat) ?? "Intro");
      packs.set(positionKey(slot, beat), await evidence.gather(evidenceBeatFor(s, beat, mode, slotNeighbours(act, slot)), ctx));
    })
  );
  /* In PLAY ORDER, not resolution order: the writer reads the documents in
     the order the act plays them, and a stub that cites "the first window"
     cites the one that played first. F-88's ground follows, as documents
     of kind `page` a thesis seam may quote whole sentences of. */
  const documents = [...actDocuments(beatsInOrder.map(({ slot, beat }) => packs.get(positionKey(slot, beat))!)), ...groundDocsFor(ground)];

  /* GV-73: the streamed path, when asked for and the writer can stream.
     Its seam layout makes line 1 an introduction only (`introOnlyFirstSeam`),
     so the act's first seam can be released on code checks alone. */
  const streaming = options.streamSeams === true && typeof writer.writeActStream === "function";
  if (streaming && stats) {
    stats.seamsReleasedEarly = stats.seamsReleasedEarly ?? 0;
    stats.releasedThenRefused = stats.releasedThenRefused ?? 0;
  }

  /* 2. THE CLIPS, in play order, each with its opening and its Intro
        weight (Q-02). */
  const seamPlans = streaming ? introOnlyFirstSeam(planActSeams(act)) : planActSeams(act);
  const clips: ClipState[] = [];
  let previousClip: SeamClip | undefined;
  /* Q-09: every show this Foray has already named, canonicalised. Seeded from
     the acts before this one and added to as this act's clips are laid out. */
  const showsHeard = new Set<string>((options.showsIntroduced ?? []).map((show) => canonicalShowKey(show)).filter((k) => k.length > 0));
  for (const plan of seamPlans) {
    if (!plan.introduces) continue;
    const clip = plan.introduces;
    const pack = packs.get(positionKey(clip.slot, clip.beat));
    const window = documents.find((d) => d.docId === tapeDocIdFor(clip.tape.segmentId));
    const windowText = window?.text ?? "";
    const opening = clipOpening(windowText, clip.tape.startAnchor);
    const titles = titlesForClip(clip, pack, window, options.segmentSources);
    clips.push({
      plan: clip,
      windowText,
      ...(window ? { window } : {}),
      brief: {
        clipId: clip.clipId,
        segmentId: clip.tape.segmentId,
        itemId: clip.tape.itemId,
        show: titles.show,
        title: titles.title,
        ...(window ? { docId: window.docId } : {}),
        opening,
        durationSec: clipDurationSec(clip.tape),
        intro: decideIntro(clip.tape, previousClip?.tape, opening),
        /* Q-09: is this the first time the listener meets this show? Keyed on
           the show's canonical name, not the episode id — two episodes of one
           show are one show. The set carries across acts (`showsIntroduced`),
           because a listener does not forget a name at an act boundary. */
        showFirstHeard: noteShowHeard(showsHeard, titles.show),
        /* F-99: every beat this one clip carries — its own, and any beat
           §4.5 merged into it. Printed on the CLIP line so the writer
           knows what the tape already says and the verifier judges both
           beats against the one window. */
        carries: clip.carries.map((c) => ({ beatId: c.beatId, claim: c.claim }))
      }
    });
    previousClip = clip;
  }
  const clipById = new Map(clips.map((c) => [c.brief.clipId, c]));

  /* 3. THE SEAMS. */
  const seams: SeamState[] = seamPlans.map((plan) => seamStateOf(plan, plan.introduces ? clipById.get(plan.introduces.clipId)!.brief.intro : undefined, documents));
  const beats = new Map<string, BeatState>();
  for (const seam of seams) {
    for (const b of seam.plan.beats) {
      beats.set(b.beatId, {
        brief: { beatId: b.beatId, claim: b.claim, mode: b.mode, kind: b.kind, ...(b.seedLost ? { seedLost: true as const } : {}) },
        seamId: seam.plan.seamId,
        carried: false
      });
    }
  }

  /* 4. ROUNDS — at most `NARRATION_PAGE_ATTEMPTS` per act (GV-80: or the
        round policy's `maxRounds`). */
  const maxRounds = options.roundPolicy?.maxRounds ?? NARRATION_PAGE_ATTEMPTS;
  /* GV-80: on the timed policy, round 2 onwards is a seam edit when the
     writer offers one; without it the round re-sends the whole act. */
  const seamEdits = options.roundPolicy?.editScope === "seams" && typeof writer.editSeams === "function";
  /* GV-80: what each seam's last reply cited, for the edit request's
     documents. Kept only when seam edits can happen. */
  const citedBy = new Map<string, string[]>();
  const actRejections: string[] = [];
  const clipSourceCount = clips.filter((c) => c.window).length + ground.length;
  /* GV-73: after a streamed reply was cut (token cap or stall), the next
     round's request lists only the seams still open -- the frozen ones are
     not echoed back, so the retry fits under the cap the cut one hit. */
  let askOnly: Set<string> | undefined;
  /* GV-113: what the sentence cut needs from the act, only under `cut`. */
  const sentenceCut: SentenceCutContext | undefined =
    options.sentencePolicy === "cut" ? { seams, clipById, clipSourceCount, specifics: options.specifics ?? "report", voiceEnforce } : undefined;
  for (let round = 1; round <= maxRounds; round++) {
    if (round > 1 && stats) stats.retryRounds += 1;

    /* GV-07: the writer's model calls are recorded with this round and role
       (a no-op wrapper outside a RunLog; the request is unchanged). */
    const asked = askOnly;
    const writeRequest = {
      actTitle: act.title,
      voice,
      seams: (asked ? seams.filter((s) => asked.has(s.plan.seamId)) : seams).map(seamBriefOf),
      clips: clips.map((c) => c.brief),
      documents,
      ...(ground.length > 0 ? { ground: [...ground] } : {}),
      ...(actRejections.length > 0 ? { retryNote: retryNoteFrom(actRejections) } : {}),
      /* GV-38: the act frame, on every round. */
      ...(options.frame ? { frame: options.frame } : {})
    };
    let reply: ActWriteResult;
    let cut: StreamCut | undefined;
    /* GV-110: what the writer was sent and returned this round, for
       `onExchange`. Set only when a recorder is listening. */
    let exchange: Pick<WriterExchange, "call" | "request" | "reply"> | undefined;
    /* GV-80: the timed policy's edit round -- only the failing seams, the
       seams beside them, the clips they touch and the documents they cite.
       Every other seam is padded back with its current text, so the gate
       below reads a whole act exactly as on a whole-act round. */
    const editing = seamEdits && round > 1 ? failingSeams(seams) : [];
    if (editing.length > 0) {
      const editRequest = seamEditRequestOf(editing, seams, clips, documents, (seam) => seamDocIds(seam, beats, packs, seamPlans, citedBy), {
        actTitle: act.title,
        voice,
        retryNote: retryNoteFrom(actRejections),
        ...(options.frame ? { frame: options.frame } : {})
      });
      const edited = await withCallContext({ attempt: round, role: "writer" }, () => writer.editSeams!(editRequest, ctx));
      if (options.onExchange) exchange = { call: "editSeams", request: editRequest, reply: edited };
      reply = padSeamEdit(seams, editRequest, edited, act.title, round);
    } else if (streaming) {
      /* GV-73: the same request, streamed (the frame rides along as on the
         one-shot call); round 1 checks each seam as its line closes. */
      const streamed = await withCallContext({ attempt: round, role: "writer" }, () =>
        streamRound(writeRequest, ctx, { round, act, voice, seams, clips, clipById, clipSourceCount, ground, documents, options })
      );
      reply = { seams: streamed.seams };
      cut = streamed.cut;
      if (cut) console.warn(`writeAct: act "${act.title}" round ${round} — the streamed reply was cut (${cut.note}); keeping the ${streamed.seams.length} finished seam(s)`);
      if (options.onExchange) exchange = { call: "writeActStream", request: writeRequest, reply };
    } else {
      reply = await withCallContext({ attempt: round, role: "writer" }, () => writer.writeAct(writeRequest, ctx));
      if (options.onExchange) exchange = { call: "writeAct", request: writeRequest, reply };
    }
    if (seamEdits) noteCitations(citedBy, reply);

    /* THE MECHANICAL GATE, seam by seam, in two passes (`mechanicalPass`):
       first every seam's claims through the quote gate (the act's source
       set is the union of what survives), then every seam's script through
       the structural rules against that set. A frozen seam is not re-read:
       its text is kept whatever the writer returned. */
    const mechanical = mechanicalPass(seams, reply, clipById, clipSourceCount, round, act.title, options.specifics, cut, voiceEnforce);
    if (mechanical.length > 0) {
      console.warn(`writeAct: act "${act.title}" round ${round} refused in code — ${mechanical.join(" | ").slice(0, 600)}`);
    }

    /* THE ACT'S SOURCE SET, from what survived: every seam's gated claims
       (frozen seams included — another seam may rest on them), every
       clip's window, every ground page. */
    const actSources = buildActSources(seams, clips, ground, documents);

    /* THE VERIFIER, once, for the seams that changed this round and the
       beats still open (plus the beats a changed seam was carrying). */
    const toJudge = seams.filter((s) => s.draft && s.changed);
    for (const state of beats.values()) {
      if (state.carried && state.carriedBy && toJudge.some((s) => s.plan.seamId === state.carriedBy)) {
        state.carried = false;
        delete state.carriedBy;
        delete state.verifiedAtAttempt;
      }
    }
    const hasScript = (seamId: string): boolean => seams.some((s) => s.plan.seamId === seamId && s.draft !== undefined);
    /* F-99: a seed-lost beat closed in an earlier round is off the
       checklist — asking again costs a round and cannot change the
       answer, and asking twice would count it twice. */
    const open = [...beats.values()].filter((b) => !b.carried && !b.seedLostClosed && hasScript(b.seamId));
    /* GV-110: the round's verdict, for `onExchange`. */
    let verdict: ActVerifyResult | undefined;
    if (toJudge.length > 0) {
      const verifyRequest = {
        actTitle: act.title,
        voice,
        beats: open.map((b) => b.brief),
        seams: seams.filter((s) => s.draft).map((s) => verifySeamBriefOf(s, actSources)),
        clips: clips.map((c): VerifyClipBrief => ({ ...c.brief, windowText: c.windowText })),
        sources: actSources.map((s) => s.brief),
        ...(ground.length > 0 ? { ground: [...ground] } : {}),
        documents
      };
      const verdicts = await withCallContext({ attempt: round, role: "verifier" }, () => verifier.verifyAct(verifyRequest, ctx));
      judge(toJudge, open, verdicts, actSources, round, act.title, stats, sentenceCut);
      verdict = verdicts;
    }
    /* GV-113: a seam whose orphan edit round did not end confirmed keeps the
       trimmed text it was cut to; its refusal this round is no note. */
    const held = sentenceCut ? holdOrphanEdits(seams, beats, round, act.title) : new Set<string>();
    /* GV-73: a released seam the verifier refused is not edited (it may be
       playing); its beats move to the next seam still open. */
    if (streaming) settleReleased(seams, beats, round, act.title, stats);

    /* WHAT FAILED: a seam refused in code, a seam the verifier refused, a
       seam whose positioned beat is not carried anywhere. Everything else
       is frozen from here on. A seam's beats are the ones positioned in it
       -- on the streamed path, plus any a released seam handed on. */
    const notes = roundNotes(
      seams,
      beats,
      held.size > 0 ? mechanical.filter((m) => ![...held].some((seamId) => m.startsWith(`seam ${seamId}: `))) : mechanical,
      round
    );
    for (const seam of seams) {
      if (seam.draft && seam.confirmed && beatsIn(seam, beats).every((b) => beatSettled(b) || orphanSpent(b, round))) {
        seam.frozen = true;
        delete seam.notes;
      } else if (seam.confirmed && seam.draft) {
        /* Confirmed text, but a beat of its own is missing: open it for
           editing. The confirmation stands if the writer leaves it alone. */
        seam.frozen = false;
      }
      /* GV-73: released means never edited again, whatever the verdict. */
      if (seam.released) seam.frozen = true;
    }
    /* GV-110: the bench recorder, once per round, at the round's end. */
    if (options.onExchange && exchange) {
      try {
        options.onExchange({ actTitle: act.title, round, ...exchange, mechanical: [...mechanical], ...(verdict ? { verdict } : {}) } as WriterExchange);
      } catch (err) {
        console.warn(`writeAct: onExchange threw for act "${act.title}" round ${round}; ignored (${err instanceof Error ? err.message : String(err)})`);
      }
    }
    if (notes.length === 0) break;
    actRejections.push(notes.join(" | "));
    askOnly = cut ? new Set(seams.filter((s) => !s.frozen).map((s) => s.plan.seamId)) : undefined;
  }

  /* GV-108: under FORAY_UNVERIFIED_SEAM_POLICY=cut a failing seam is cut to
     its introduction or dropped, held to the gates this act enforces. */
  const cut: CutPolicy | undefined =
    options.unverifiedSeamPolicy === "cut" ? { clipById, voiceEnforce, specifics: options.specifics ?? "report" } : undefined;
  return assemble(act, seams, beats, cut);
}

/* ------------------------------------------------------------------ */
/* The round's parts                                                    */
/* ------------------------------------------------------------------ */

function positionKey(slot: number, beat: number): string {
  return `${slot}/${beat}`;
}

/* ------------------------------------------------------------------ */
/* GV-80: the timed policy's seam edit                                  */
/* ------------------------------------------------------------------ */

/** The seams an edit round asks for, in play order: every seam that is not
 * frozen, except a clean silent one (no beats, intro not full, came back
 * empty), which is no failure and is padded back as silence. */
function failingSeams(seams: SeamState[]): SeamState[] {
  return seams.filter((s) => !s.frozen && !s.silent);
}

/** Records which documents each seam of a reply cited (its claims' docIds). */
function noteCitations(citedBy: Map<string, string[]>, reply: ActWriteResult): void {
  for (const written of reply.seams ?? []) {
    const claims = Array.isArray(written?.claims) ? written.claims : [];
    citedBy.set(String(written?.seamId), claims.map((c) => String(c?.docId ?? "")).filter((id) => id.length > 0));
  }
}

/** The docIds a failing seam cites: what its last reply's claims named, and
 * the evidence of every beat it answers for (positioned in it, or handed to
 * it by a released seam on the streamed path). */
function seamDocIds(seam: SeamState, beats: Map<string, BeatState>, packs: Map<string, EvidencePack>, seamPlans: SeamPlan[], citedBy: Map<string, string[]>): string[] {
  const beatIds = new Set([...seam.plan.beats.map((b) => b.beatId), ...beatsIn(seam, beats).map((b) => b.brief.beatId)]);
  const fromBeats = seamPlans
    .flatMap((plan) => plan.beats)
    .filter((b) => beatIds.has(b.beatId))
    .flatMap((b) => (packs.get(positionKey(b.slot, b.beat))?.docs ?? []).map((d) => d.docId));
  return [...(citedBy.get(seam.plan.seamId) ?? []), ...fromBeats];
}

/**
 * The short request of an edit round (`SeamEditRequest`): the failing seams'
 * briefs (each with its previous script and notes), the seam before and
 * after each that is not itself being edited, the clips they follow or
 * introduce, and the documents they cite plus those clips' windows -- in the
 * act's own document order, so a quote resolves exactly as on round 1.
 */
function seamEditRequestOf(
  editing: SeamState[],
  seams: SeamState[],
  clips: ClipState[],
  documents: EvidenceDoc[],
  docIdsOf: (seam: SeamState) => string[],
  head: Pick<SeamEditRequest, "actTitle" | "voice" | "retryNote" | "frame">
): SeamEditRequest {
  const editIds = new Set(editing.map((s) => s.plan.seamId));
  const neighbourIndexes = new Set<number>();
  seams.forEach((seam, index) => {
    if (!editIds.has(seam.plan.seamId)) return;
    for (const at of [index - 1, index + 1]) {
      const near = seams[at];
      if (near && !editIds.has(near.plan.seamId)) neighbourIndexes.add(at);
    }
  });
  const neighbours: SeamNeighbour[] = [...neighbourIndexes]
    .sort((a, b) => a - b)
    .map((at) => {
      const near = seams[at]!;
      return { seamId: near.plan.seamId, script: near.draft?.script ?? near.previousScript ?? "" };
    });
  const clipIds = new Set(editing.flatMap((s) => [s.plan.follows?.clipId, s.plan.introduces?.clipId]).filter((id): id is string => id !== undefined));
  const touched = clips.filter((c) => clipIds.has(c.brief.clipId));
  const docIds = new Set([...editing.flatMap(docIdsOf), ...touched.flatMap((c) => (c.brief.docId ? [c.brief.docId] : []))]);
  return {
    actTitle: head.actTitle,
    voice: head.voice,
    ...(head.frame ? { frame: head.frame } : {}),
    seams: editing.map(seamBriefOf),
    neighbours,
    clips: touched.map((c) => c.brief),
    documents: documents.filter((d) => docIds.has(d.docId)),
    retryNote: head.retryNote
  };
}

/**
 * The edit reply as a whole act: each requested seam as the writer returned
 * it (a missing one stays missing, and the gate refuses it as on any round),
 * every other seam padded with its current text -- a frozen seam's
 * confirmed draft, a silent seam's empty script. A seam the writer returned
 * but was not asked for is ignored.
 */
function padSeamEdit(seams: SeamState[], request: SeamEditRequest, edited: ActWriteResult, actTitle: string, round: number): ActWriteResult {
  const asked = new Set(request.seams.map((s) => s.seamId));
  const returned = Array.isArray(edited?.seams) ? edited.seams : [];
  const extra = returned.filter((s) => !asked.has(s?.seamId));
  if (extra.length > 0) {
    console.warn(`writeAct: act "${actTitle}" round ${round} — the seam edit returned seam(s) it was not asked for (${extra.map((s) => s?.seamId).join(", ")}); keeping their current text`);
  }
  const out: WrittenSeam[] = [];
  for (const seam of seams) {
    const seamId = seam.plan.seamId;
    if (asked.has(seamId)) {
      const written = returned.find((s) => s?.seamId === seamId);
      if (written) out.push(written);
      continue;
    }
    const draft = seam.draft;
    out.push(
      draft
        ? { seamId, script: draft.script, claims: draft.claims, usedClaims: draft.claims.map((_, i) => i), pronunciationHints: draft.hints }
        : { seamId, script: "", claims: [], usedClaims: [], pronunciationHints: [] }
    );
  }
  return { seams: out };
}

/** A clip as the gate needs it: the brief and the held window. */
type GateClip = Pick<ClipState, "brief" | "window">;

/** A seam's state at the start of an act: the gate's view of it — the
 * act's documents, the beats' claims as the purpose text (F-46), tape
 * citable whatever the mode, no per-page claim quota (`claimsOptional`). */
function seamStateOf(plan: SeamPlan, intro: IntroKind | undefined, documents: EvidenceDoc[]): SeamState {
  const purpose = plan.beats.map((b) => b.claim).join(" ");
  return {
    plan,
    band: seamBand(plan),
    ...(intro ? { intro } : {}),
    gate: {
      pageId: plan.seamId,
      beatIndex: plan.beats[0]?.beat ?? plan.introduces?.beat ?? 0,
      claim: purpose,
      mode: seamMode(plan),
      evidence: { purpose, beatKind: "account", docs: documents },
      citesTape: true,
      claimsOptional: true
    },
    attempts: [],
    changed: false,
    frozen: false
  };
}

/**
 * The mechanical gate on one writer reply, in two passes: every unfrozen
 * seam's claims through the quote gate, then every gated seam's script
 * through the structural rules against the act's source set — the other
 * seams' surviving claims, the clips' windows, the ground. Leaves each
 * seam with a `draft` or a recorded rejection; returns the refusals.
 *
 * GV-73: a seam released early on the streamed path was gated as its line
 * closed and is not re-read (like a frozen one); it stays `changed` in the
 * round it was released in, so the act's verifier judges it with the rest.
 * After a cut reply (`cut`), a seam the writer never reached gets the cut's
 * note -- "unfinished: the writer stopped at its token cap" -- instead of the
 * missing-seam refusal, and is asked for again.
 */
function mechanicalPass(
  seams: SeamState[],
  reply: ActWriteResult,
  clipById: Map<string, GateClip>,
  clipSourceCount: number,
  round: number,
  actTitle: string,
  specifics: SpecificsMode = "report",
  cut?: StreamCut,
  voiceEnforce = false
): string[] {
  const mechanical: string[] = [];
  const pending = new Map<string, { script: string; claims: SelectedClaim[]; hints: NarratedBeat["pronunciationHints"] }>();
  for (const seam of seams) {
    const written = reply.seams.find((s) => s.seamId === seam.plan.seamId);
    seam.changed = false;
    if (seam.frozen) {
      const returned = written ? decodeEntities(String(written.script ?? "")).trim() : undefined;
      if (returned !== undefined && returned !== seam.draft!.script) {
        console.warn(`writeAct: act "${actTitle}" round ${round} — the writer changed frozen seam ${seam.plan.seamId}; keeping the confirmed text`);
      }
      continue;
    }
    if (seam.released) {
      seam.changed = seam.released.round === round;
      continue;
    }
    if (cut && !written) {
      delete seam.draft;
      delete seam.silent;
      delete seam.confirmed;
      mechanical.push(`seam ${seam.plan.seamId}: ${rejectSeam(seam, [cut.note], [], round)}`);
      continue;
    }
    const gated = gateSeamClaims(seam, written, round);
    if (typeof gated === "string") {
      if (gated.length > 0) mechanical.push(`seam ${seam.plan.seamId}: ${gated}`);
      continue;
    }
    pending.set(seam.plan.seamId, gated);
  }
  const claimCount = (seamId: string): number => pending.get(seamId)?.claims.length ?? seams.find((s) => s.plan.seamId === seamId)?.draft?.claims.length ?? 0;
  const totalClaims = seams.reduce((n, s) => n + claimCount(s.plan.seamId), 0);
  const quotesOf = (exceptSeam: string): string[] =>
    seams.flatMap((s) => (s.plan.seamId === exceptSeam ? [] : (pending.get(s.plan.seamId)?.claims ?? s.draft?.claims ?? []).map((c) => c.quote)));
  /* GV-34: the act's source TEXTS, once per pass and only when enforcing —
     a seam's own quotes plus every other seam's (`actSourceQuotes`), the
     clips' windows and the ground pages; and the names the check never asks
     about, the act's clip shows and episode titles. */
  const specificsScope = specifics === "enforce" ? actSpecificsScope(seams, clipById, quotesOf("")) : undefined;
  for (const seam of seams) {
    const p = pending.get(seam.plan.seamId);
    if (!p) continue;
    const issues = validateSeam(seam, p, clipById, round, {
      actSourceCount: clipSourceCount + totalClaims - p.claims.length,
      actSourceQuotes: quotesOf(seam.plan.seamId),
      ...(specificsScope ? { specifics: specificsScope } : {}),
      ...(voiceEnforce ? { voice: true as const } : {})
    });
    if (issues.length > 0) mechanical.push(`seam ${seam.plan.seamId}: ${issues.join("; ")}`);
  }
  return mechanical;
}

/**
 * GV-104: whether the voice gate re-asks this act's seams. The act's
 * position is `ctx.actIndex` (the pipeline sets it per `narrate:<i>` stage,
 * where `writeNarration` sees one act at index 0), else the options' own
 * `actIndex`, else 0.
 */
function voiceEnforcedFor(options: WriteActOptions, ctx: NarrationBuildContext): boolean {
  return voiceGateEnforces(options.voiceGate, ctx.actIndex ?? options.actIndex ?? 0);
}

/** GV-34: what `validateSeam` checks a seam's specifics against. */
interface SpecificsScope {
  texts: PreparedSources;
  allowNames: string[];
}

/** GV-34: the act's source texts — every gated claim's quote, every clip's
 * transcript window, every ground page (F-88's `page` documents) — prepared
 * once, with the act's clip shows and episode titles as the allowed names. */
function actSpecificsScope(seams: SeamState[], clipById: Map<string, GateClip>, quotes: string[]): SpecificsScope {
  const windows = [...clipById.values()].map((c) => c.window?.text ?? "").filter((t) => t.length > 0);
  const groundPages = (seams[0]?.gate.evidence.docs ?? []).filter((d) => d.kind === "page").map((d) => d.text);
  const allowNames = [...clipById.values()].flatMap((c) => [c.brief.show, c.brief.title]).filter((n) => n.trim().length > 0);
  return { texts: prepareSpecificsSources([...quotes, ...windows, ...groundPages]), allowNames };
}

/**
 * F-97: the mechanical gate alone, on a RECORDED writer exchange — the
 * request as the writer saw it and the reply it gave — so a run's queue
 * files can be replayed against the current rules without a model call
 * (the run-9 replay in the F-97 PR body). The seams are rebuilt from the
 * writer's own briefs; nothing here depends on the sourced act. Returns,
 * per seam, the issues the gate raises now (none for a clean seam), the
 * gated claim count, and whether the seam is silent.
 */
export function replayMechanicalGate(
  request: Pick<ActWriteRequest, "seams" | "clips" | "documents"> & { ground?: ReadonlyArray<GroundPageBrief> },
  reply: ActWriteResult,
  round = 1
): Array<{ seamId: string; issues: string[]; claims: number; silent: boolean }> {
  const clipById = new Map<string, GateClip>(
    request.clips.map((c) => {
      const window = c.docId ? request.documents.find((d) => d.docId === c.docId) : undefined;
      return [c.clipId, { brief: c, ...(window ? { window } : {}) }];
    })
  );
  const clipOf = (clipId: string): SeamClip => {
    const brief = clipById.get(clipId)!.brief;
    return {
      slot: 0,
      beat: 0,
      clipId,
      claim: "",
      tape: { segmentId: brief.segmentId, itemId: brief.itemId, startSec: 0, endSec: brief.durationSec, startAnchor: "", endAnchor: "", tier: 1, confidence: "high" },
      /* F-99: the beats the recorded request says this clip carries. A
         request recorded before F-99 (the run-9 replay) has none, and the
         mechanical gate reads none of them — nothing here depends on it. */
      carries: (brief.carries ?? []).map((b) => ({ slot: 0, beat: 0, beatId: b.beatId, claim: b.claim }))
    };
  };
  const seams = request.seams.map((brief) =>
    seamStateOf(
      {
        seamId: brief.seamId,
        beats: brief.beats.map((b) => ({
          slot: 0,
          beat: 0,
          beatId: b.beatId,
          claim: b.claim,
          mode: b.mode === "Carry" ? "Carry" : ("Patch" as const),
          kind: b.kind,
          exploration: false,
          ...(b.seedLost ? { seedLost: true as const } : {})
        })),
        ...(brief.follows ? { follows: clipOf(brief.follows) } : {}),
        ...(brief.introduces ? { introduces: clipOf(brief.introduces) } : {})
      },
      brief.intro,
      request.documents
    )
  );
  const refused = mechanicalPass(seams, reply, clipById, [...clipById.values()].filter((c) => c.window).length + (request.ground?.length ?? 0), round, "replay");
  return seams.map((seam) => {
    const own = refused.filter((r) => r.startsWith(`seam ${seam.plan.seamId}: `)).map((r) => r.slice(`seam ${seam.plan.seamId}: `.length));
    return { seamId: seam.plan.seamId, issues: own, claims: seam.draft?.claims.length ?? 0, silent: seam.silent === true };
  });
}

/** Every document any beat of the act holds, once each, act-wide: a
 * seam may quote any of them (a beat's claim may be carried in another
 * seam), and a window's position relative to one page is meaningless
 * across an act — the layout says where each clip plays. */
export function actDocuments(packs: EvidencePack[]): EvidenceDoc[] {
  const out = new Map<string, EvidenceDoc>();
  /* GV-76 review fix: the docIds whose held copy is a neighbour's head+tail
     excerpt (`adjacentExcerpt`). With `FORAY_EVIDENCE_WHOLE_CLIP` on, the
     Intro page plays BEFORE its clip and holds that clip as its `next`
     document in head+tail form; first-in-play-order would hand the writer,
     the verifier and the clip-window read (`ClipState.window`) the excerpt
     and lose R2-12 (judge a clip against the whole clip). So the clip's OWN
     copy (no `adjacentExcerpt`) replaces an excerpt whatever the order; the
     document keeps the position its first copy took (Map.set on a held key).
     The rule reads the flag gatherEvidence sets, not text length. With the
     flag off nothing carries `adjacentExcerpt` and this is first-wins, as
     before, byte for byte. */
  const excerpts = new Set<string>();
  for (const pack of packs) {
    for (const doc of pack.docs) {
      if (out.has(doc.docId) && !(excerpts.has(doc.docId) && doc.adjacentExcerpt !== true)) continue;
      const { tapePosition: _position, adjacentExcerpt, ...rest } = doc;
      out.set(doc.docId, rest);
      if (adjacentExcerpt === true) excerpts.add(doc.docId);
      else excerpts.delete(doc.docId);
    }
  }
  return [...out.values()];
}

/** F-88's ground (`synthesisVerify.ts`) as the writer's documents, so a quote
 * of a verified page resolves through the same gate every other quote
 * does. The ONE builder of these documents since F-100 deleted F-88's own
 * pass and the second, identical copy that lived in it. */
export function groundDocsFor(ground: ReadonlyArray<GroundPageBrief>): EvidenceDoc[] {
  return ground.map((p) => ({
    docId: pageDocIdFor(p.pageId),
    kind: "page" as const,
    title: `This Foray, page ${p.pageId} — ${p.claim.slice(0, 80)}`,
    text: p.script
  }));
}

/** The show and episode a clip comes from — what an Intro must name. From
 * the pack's tape context (the committed registry + catalogue, via
 * `titlesForItem`), else the minted source rows this run carries, else the
 * window document's own title (`"<show> — <episode>"`). Empty strings when
 * nothing names it: `introNamesSource` then cannot pass, and the writer is
 * told to lean on what the tape itself says. */
export function titlesForClip(
  clip: SeamClip,
  pack: EvidencePack | undefined,
  window: EvidenceDoc | undefined,
  segmentSources: ReadonlyArray<{ id: string; show: string; title: string }> | undefined
): { show: string; title: string } {
  if (pack?.tape) return { show: pack.tape.showTitle, title: pack.tape.episodeTitle };
  const minted = segmentSources?.find((s) => s.id === clip.tape.itemId);
  if (minted) return { show: minted.show, title: minted.title };
  if (window) {
    const at = window.title.indexOf(" — ");
    if (at > 0) return { show: window.title.slice(0, at), title: window.title.slice(at + 3) };
    return { show: "", title: window.title };
  }
  return { show: "", title: "" };
}

function seamBriefOf(seam: SeamState): SeamBrief {
  return {
    seamId: seam.plan.seamId,
    /* F-99: `seedLost` travels to the WRITER too — the prompt prints the
       "its tape was not available" line under the beat, which is the only
       place a writer looking at one claim reads it. */
    beats: seam.plan.beats.map((b) => ({ beatId: b.beatId, claim: b.claim, mode: b.mode, kind: b.kind, ...(b.seedLost ? { seedLost: true as const } : {}) })),
    ...(seam.plan.follows ? { follows: seam.plan.follows.clipId } : {}),
    ...(seam.plan.introduces ? { introduces: seam.plan.introduces.clipId } : {}),
    ...(seam.intro ? { intro: seam.intro } : {}),
    band: seam.band,
    ...(seam.previousScript !== undefined ? { previousScript: seam.previousScript } : {}),
    ...(seam.frozen ? { frozen: true } : {}),
    ...(!seam.frozen && seam.notes ? { notes: seam.notes } : {})
  };
}

function verifySeamBriefOf(seam: SeamState, actSources: ActSource[]): VerifySeamBrief {
  return {
    seamId: seam.plan.seamId,
    script: seam.draft!.script,
    selected: actSources.filter((s) => s.brief.selectedBy === seam.plan.seamId).map((s) => s.brief.id),
    carries: seam.plan.beats.map((b) => b.beatId),
    ...(seam.plan.follows ? { follows: seam.plan.follows.clipId } : {}),
    ...(seam.plan.introduces ? { introduces: seam.plan.introduces.clipId } : {}),
    ...(seam.intro ? { intro: seam.intro } : {}),
    ...(seam.frozen ? { frozen: true } : {})
  };
}

/**
 * F-97: the act's source set for this round — `k<n>` every gated claim of
 * every seam that has a script (its own source shape resolved once, here),
 * `c<n>` every clip whose window is held, `p<n>` every ground page. The
 * verifier names entries of this list; `sourcesForRest` turns the names
 * back into a page's `sources`.
 */
export function buildActSources(
  seams: ReadonlyArray<Pick<SeamState, "plan" | "draft" | "gate">>,
  clips: ReadonlyArray<Pick<ClipState, "brief" | "window">>,
  ground: ReadonlyArray<GroundPageBrief>,
  documents: EvidenceDoc[]
): ActSource[] {
  const out: ActSource[] = [];
  let k = 0;
  for (const seam of seams) {
    if (!seam.draft) continue;
    for (const [claimIndex, claim] of seam.draft.claims.entries()) {
      const [source] = sourcesFor([0], [claim], seam.gate.evidence, seam.gate.mode, true);
      if (!source) continue;
      out.push({
        claimIndex,
        brief: {
          id: `k${k++}`,
          kind: "claim",
          claimText: source.claimText,
          ...(source.quote ? { quote: source.quote } : {}),
          publication: source.publication,
          contested: source.contested,
          selectedBy: seam.plan.seamId,
          docId: claim.docId
        },
        source
      });
    }
  }
  for (const clip of clips) {
    if (!clip.window) continue;
    const source: Source = {
      kind: "tape",
      segmentId: clip.brief.segmentId,
      claimText: `what is said in clip ${clip.brief.clipId} — "${clip.brief.title}"${clip.brief.show ? ` on ${clip.brief.show}` : ""}`,
      publication: clip.window.title,
      contested: false
    };
    out.push({
      brief: { id: clip.brief.clipId, kind: "clip", claimText: source.claimText, publication: source.publication, contested: false, docId: clip.window.docId },
      source
    });
  }
  ground.forEach((page, i) => {
    const doc = documents.find((d) => d.docId === pageDocIdFor(page.pageId));
    out.push({
      brief: { id: `p${i}`, kind: "page", claimText: page.claim, publication: doc?.title ?? `This Foray, page ${page.pageId}`, contested: false, docId: pageDocIdFor(page.pageId) },
      pageId: page.pageId
    });
  });
  return out;
}

/**
 * The verifier's `restsOn`, resolved: the sources a page carries (claims
 * and clip windows, deduplicated), the ground pages it rests on, and what
 * kind of ground that is — which decides the seam's mode.
 */
export function sourcesForRest(ids: ReadonlyArray<string>, actSources: ReadonlyArray<ActSource>): { sources: Source[]; pageIds: string[]; rest: SeamRest; unknown: string[] } {
  const sources: Source[] = [];
  const pageIds: string[] = [];
  const unknown: string[] = [];
  const rest: SeamRest = { print: false, tape: false };
  const seen = new Set<string>();
  for (const id of ids) {
    const entry = actSources.find((s) => s.brief.id === id);
    if (!entry) {
      unknown.push(id);
      continue;
    }
    if (entry.pageId !== undefined) {
      if (!pageIds.includes(entry.pageId)) pageIds.push(entry.pageId);
      rest.print = true;
      continue;
    }
    const source = entry.source!;
    const key = `${isTapeSource(source) ? source.segmentId : source.publication}::${source.claimText}::${source.quote ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    sources.push(source);
    if (isTapeSource(source)) rest.tape = true;
    else rest.print = true;
  }
  return { sources, pageIds, rest, unknown };
}

/**
 * One seam's reply through the quote gate. Returns the clean script with
 * its gated claims, or the issues joined (an empty string for a seam that
 * may be silent and is). Exactly one attempt is recorded per seam per
 * round it was written, as on the per-page path.
 *
 * SILENCE IS CHOSEN, NEVER INFERRED (2026-09-13 audit, defect 1). A seam
 * that is ABSENT from the reply and a seam that came back with
 * `"script": ""` used to take the same branch, and they are not the same
 * event. `MAX_ACT_OUTPUT_TOKENS` bounds the writer's reply;
 * `parseOrRepairJson` closes the brackets of a cut-off reply, so a
 * truncated `seams` array parses as a VALID short array and every seam
 * the model never got to write arrived here as `undefined`. Under the old
 * branch each of those became `silent = true` — no rejection, no retry,
 * no warning, and a clip shipped without its Q-02 introduction. That is
 * Wyatt's own complaint from 2026-09-12 ("inadequate, if any,
 * introduction to podcast segments") surviving as a silent failure path
 * inside the card that was meant to fix it.
 *
 * So a missing seam is always a REJECTION. Only the `script.length === 0`
 * branch below — an explicitly returned empty string, which only a reply
 * the model actually finished can contain — may set `silent`. The cost of
 * being wrong the new way is one more writer round and, at worst, the
 * same dropped introduction three rounds later with a warning in the log
 * (`finalPageFor`'s intro-only drop); the cost of being wrong the old way
 * was silence nobody could see.
 */
function gateSeamClaims(seam: SeamState, written: WrittenSeam | undefined, round: number): { script: string; claims: SelectedClaim[]; hints: NarratedBeat["pronunciationHints"] } | string {
  const seamId = seam.plan.seamId;
  const hasBeats = seam.plan.beats.length > 0;
  delete seam.draft;
  delete seam.silent;
  delete seam.confirmed;
  if (!written) {
    return rejectSeam(
      seam,
      [`the writer returned no script for seam ${seamId} — every seam must come back, and a seam that is meant to be silent comes back with an empty script ("script": "")`],
      [],
      round
    );
  }
  const script = decodeEntities(String(written.script ?? "")).trim();
  seam.previousScript = script;

  if (script.length === 0) {
    if (!hasBeats && seam.intro !== "full") {
      seam.silent = true;
      return "";
    }
    return rejectSeam(
      seam,
      [
        hasBeats
          ? `seam ${seamId} came back empty but it carries ${seam.plan.beats.map((b) => b.beatId).join(", ")} — write the prose that carries them`
          : `seam ${seamId} came back empty but clip ${seam.plan.introduces!.clipId} needs a full introduction`
      ],
      [],
      round
    );
  }

  const gate = gateSelectedClaims(decodeClaimEntities(written.claims ?? []), seam.gate);
  if (gate.issues.length > 0) return rejectSeam(seam, gate.issues, [], round);
  return { script, claims: gate.valid, hints: written.pronunciationHints ?? [] };
}

/**
 * The structural rules on a gated seam, against the act's source set.
 * Leaves the seam with a `draft` (clean, ready for the verifier) or a
 * recorded rejection; returns the issues.
 */
function validateSeam(
  seam: SeamState,
  pending: { script: string; claims: SelectedClaim[]; hints: NarratedBeat["pronunciationHints"] },
  clipById: Map<string, GateClip>,
  round: number,
  actScope: {
    actSourceCount: number;
    actSourceQuotes: string[];
    specifics?: SpecificsScope;
    voice?: true;
    /** GV-113: the character band to hold the script to instead of the
     * seam's own (a trimmed seam is held to [0, ceiling]). */
    charBandOverride?: [number, number];
  }
): string[] {
  const { script, claims, hints } = pending;
  /* The provisional page: the seam's own claims as its sources, under the
     planned mode. The verifier's answer replaces both. */
  const sources = sourcesFor(
    claims.map((_, i) => i),
    claims,
    seam.gate.evidence,
    seam.gate.mode,
    true
  );
  const page: NarratedBeat = { mode: seam.gate.mode, script, sources, pronunciationHints: hints, verified: true };
  seam.lastPage = page;

  const structural = validateNarratedBeat(page, {
    bannedPhrasePatterns: BANNED,
    heldDocs: heldDocsOf(seam.gate.evidence),
    ...(seam.gate.claim ? { purposeText: seam.gate.claim } : {}),
    charBand: actScope.charBandOverride ?? seam.band,
    tapeCitable: true,
    actSourceCount: actScope.actSourceCount,
    actSourceQuotes: actScope.actSourceQuotes
  });
  const issues = structural.issues.map((i) => i.message);
  /* Q-08: the narrator never mentions the Foray's own structure. Asked in
     CODE, before the verifier, so a structural aside is a re-ask of one seam
     rather than a Foray that fails at the publish gate with nothing left to
     retry. Same rule, one definition (`copy/narratorStructure.js`), and the
     same rule §4.4's act introductions and §4.8's smoothed ones face. */
  for (const leak of narratorStructureLeaks(script)) {
    issues.push(
      `the script says "${leak.phrase}", which ${leak.why} — never mention this Foray's own acts, beats or segments (Q-08). ` +
        'A structural word is fine when it belongs to something else ("the first act of Macbeth"); say what changed, not where the listener is.'
    );
  }
  for (const source of sources) {
    if (looksLikeSlug(source.publication)) {
      issues.push(`publication "${source.publication}" is a tape item id, not a publication — cite the real work the quote comes from, or drop the claim`);
    }
  }

  /* Q-02, IN CODE. The seam before a clip: a full introduction names the
     show or someone the episode title names; no seam repeats the clip's
     first sentences, whatever the weight of its introduction. */
  const clip = seam.plan.introduces ? clipById.get(seam.plan.introduces.clipId) : undefined;
  if (clip) {
    /* The naming rule can only be checked against a source row that names
       something. A clip with neither show nor episode title (no catalogue
       or registry row behind it — the dry-run stub's tape, a tier-2 item
       whose row was not minted) is introduced from what the tape itself
       says, and the rule is waived rather than failed three times. */
    const nameable = clip.brief.show.trim().length > 0 || clip.brief.title.trim().length > 0;
    /* Q-09 — THE FIRST CLIP FROM A SHOW SAYS THE SHOW'S NAME. Wyatt,
       2026-09-13: "we should try to introduce any podcast with a brief mention
       of what podcast it is, for example 'here's a clip from XYZ emphasizing
       this point'". `showFirstHeard` is what "try to" resolves to: the show is
       named the first time this Foray plays it and never required again, so a
       sixty-minute Foray does not say "on Practical AI" nine times. A later
       clip from the same show still owes a full introduction when the EPISODE
       is new (Q-02's weight, unchanged) — it just owes a NAME, not the show's
       name, and `introNamesSource` accepts either. */
    const showNamed = clip.brief.show.trim().length > 0;
    const firstFromShow = clip.brief.showFirstHeard !== false;
    if (seam.intro === "full" && showNamed && firstFromShow && !introNamesShow(script, clip.brief)) {
      issues.push(
        `this is the first clip this Foray plays from "${clip.brief.show}" and the introduction before clip ${clip.brief.clipId} never says its name — tell the listener whose voice this is, in your own words (Q-09)`
      );
    } else if (seam.intro === "full" && nameable && !introNamesSource(script, clip.brief)) {
      issues.push(
        `the introduction before clip ${clip.brief.clipId} names neither the show ("${clip.brief.show}") nor anyone the episode title names ("${clip.brief.title}") — say who is speaking and on which show (Q-02)`
      );
    } else if (seam.intro === "full" && !nameable && round === 1) {
      console.warn(`writeAct: clip ${clip.brief.clipId} (segment ${clip.brief.segmentId}) has no show or episode title on record — its introduction cannot be checked for a name (Q-02)`);
    }
    const restated = introRestatesClip(script, clip.brief.opening);
    if (restated.restates) {
      issues.push(
        `the prose before clip ${clip.brief.clipId} repeats the clip's own first sentences ("${restated.run}") — introduce who is speaking and what to listen for; never say what the clip is about to say (Q-02)`
      );
    }
  }

  /* GV-34, `enforce` only: every year, figure and name a sentence states is
     in one of the act's source texts. Asked in CODE because the model that
     verifies is weak at exactly this (LM-23), and a re-ask of one seam is
     cheaper than a page the verifier waves through. */
  if (actScope.specifics) {
    for (const { sentence, unsupported } of unsupportedSpecificsInScript(script, actScope.specifics.texts, { allowNames: actScope.specifics.allowNames })) {
      issues.push(
        `the sentence "${sentence.slice(0, 160)}" states ${unsupported.map((u) => `"${u}"`).join(", ")}, which no source of this act carries (not a clip's transcript window, a claim's quote or an earlier act's page) — ` +
          "state only the numbers, dates and names the sources say, or leave the specific out (GV-34)"
      );
    }
  }

  /* GV-104, `enforce` from the configured act on: the spoken-line rules the
     prompt states (N7-N9) and N24's one-number-per-sentence cap, asked in
     CODE because the local writer breaks them more often than the prompt's
     first model did (R2). Hard errors only; shape and grade never gate. A
     rhetorical question is allowed only where tape plays beside the seam. */
  if (actScope.voice) {
    const hasTape = seam.plan.introduces !== undefined || seam.plan.follows !== undefined;
    for (const error of voiceReport(script, { hasTape }).hardErrors) {
      issues.push(`${error} — rewrite it in the narrator's spoken voice (narration-craft.md §5c-§5d, GV-104)`);
    }
  }

  if (issues.length > 0) {
    rejectSeam(seam, issues, sources, round);
    return issues;
  }

  seam.kept = { page };
  seam.draft = { script, claims, page, hints };
  seam.changed = true;
  return [];
}

function rejectSeam(seam: SeamState, issues: string[], sources: Source[], round: number): string {
  const note = issues.join("; ");
  seam.attempts.push({ attempt: round, sources, rejected: true, rejectionNote: note });
  seam.notes = note;
  return note;
}

/**
 * The verifier's answer applied to the seams judged this round and the
 * beats that were open: each beat's `carried`, by which seam, resting on
 * what, and the round it was first confirmed on; each seam's confirmation
 * with the sources it rests on, or its note.
 */
function judge(
  toJudge: SeamState[],
  open: BeatState[],
  verdicts: ActVerifyResult,
  actSources: ActSource[],
  round: number,
  actTitle: string,
  stats?: NarrationWriteStats,
  sentenceCut?: SentenceCutContext
): void {
  for (const state of open) {
    const verdict = verdicts.beats.find((v) => v.beatId === state.brief.beatId);
    const carried = verdict?.carried === true;
    state.carried = carried;
    if (carried) {
      state.carriedBy = verdict!.carriedBy ?? state.seamId;
      if (verdict!.restsOn) state.restsOn = verdict!.restsOn;
      if (state.verifiedAtAttempt === undefined) state.verifiedAtAttempt = round;
      delete state.notes;
      continue;
    }
    delete state.carriedBy;
    delete state.verifiedAtAttempt;
    state.notes = verdict ? (verdict.notes ?? "") : "the verifier returned no verdict for this beat";
    /* F-99: THE SEED IS GONE AND THE ACT CANNOT REACH IT. A `seedLost`
       beat the verifier has now read the whole act against is closed
       here, on its FIRST judgement: the claim was written from tape §4.5
       could not place, so there is no source in the act for the writer to
       rest it on and no note it can answer. Two more rounds would buy two
       more writer calls and the same refusal (six of run 9's eight
       unverified pages were exactly this). The fix is at seeding; this is
       the honest report of it. It takes a VERDICT to close one: a verifier
       that answered nothing for the beat has not read it against the act,
       and a missing verdict is a retry like any other. */
    if (state.brief.seedLost === true && verdict !== undefined) {
      state.seedLostClosed = true;
      if (stats) stats.seedLostBeats = (stats.seedLostBeats ?? 0) + 1;
      console.warn(
        `writeAct: act "${actTitle}" — beat ${state.brief.beatId} was seeded from tape this Foray never clipped (seedLost, F-96) and the act's sources do not carry it; closing it as seed-lost after one round rather than retrying (F-99): ${state.brief.claim.slice(0, 160)}`
      );
    }
  }

  /* GV-113: the seams trimmed this round, with the sentences cut. */
  const trimmed: Array<{ seam: SeamState; cut: Set<number> }> = [];
  for (const seam of toJudge) {
    const verdict = verdicts.seams.find((v) => v.seamId === seam.plan.seamId);
    if (sentenceCut && verdict?.sentences && !seam.released) {
      const cut = cutUnsupportedSentences(seam, verdict, actSources, round, actTitle, sentenceCut);
      if (cut) {
        seam.attempts.push({ attempt: round, sources: cut.resolved.sources, rejected: false });
        delete seam.notes;
        seam.confirmed = { sources: cut.resolved.sources, rest: cut.resolved.rest, pageIds: cut.resolved.pageIds, round, notes: cut.note };
        trimmed.push({ seam, cut: cut.indexes });
        continue;
      }
    }
    const failures: string[] = [];
    let resolved = sourcesForRest([], actSources);
    if (!verdict) failures.push("the verifier returned no verdict for this seam");
    else {
      if (!verdict.claimsSupported) failures.push("a statement in the script is not supported by any source in the act");
      if (!verdict.contestedHandled) failures.push("a genuinely contested point is not handled as §4.7 rule 3 requires");
      if (failures.length === 0) {
        /* What the seam rests on: the verifier's answer, else — when it
           confirmed support but named nothing — the seam's own selected
           claims. A seam that states something and rests on nothing is
           not confirmed: F-36/F-37, act-scoped. */
        const own = actSources.filter((s) => s.brief.selectedBy === seam.plan.seamId).map((s) => s.brief.id);
        const ids = (verdict.restsOn ?? []).length > 0 ? verdict.restsOn : own;
        resolved = sourcesForRest(ids, actSources);
        if (resolved.unknown.length > 0) {
          console.warn(`writeAct: seam ${seam.plan.seamId} — the verifier named source(s) not in the act's set (${resolved.unknown.join(", ")}); ignored`);
        }
        if (resolved.sources.length === 0 && resolved.pageIds.length === 0 && hasDeclarativeSentence(seam.draft!.script)) {
          failures.push("the script states something about the world but rests on no source in the act — a seam that asserts something must rest on at least one act source (a clip's window, a document span, a verified page)");
        }
      }
    }
    const seamNote = verdict?.notes;
    if (failures.length > 0) {
      const note = `${failures.join("; ")}${seamNote ? ` — ${seamNote}` : ""}`;
      seam.notes = note;
      seam.kept = { page: seam.draft!.page, notes: note };
      seam.attempts.push({ attempt: round, sources: seam.draft!.page.sources, rejected: true, rejectionNote: note });
      delete seam.confirmed;
      continue;
    }
    seam.attempts.push({ attempt: round, sources: resolved.sources, rejected: false });
    delete seam.notes;
    seam.confirmed = { sources: resolved.sources, rest: resolved.rest, pageIds: resolved.pageIds, round, ...(seamNote ? { notes: seamNote } : {}) };
  }
  for (const { seam, cut } of trimmed) reopenOrphans(seam, cut, open, verdicts, round, actTitle);
}

/** F-99: a beat that no longer holds its seam open — carried, or closed
 * as seed-lost. */
function beatSettled(state: BeatState): boolean {
  return state.carried || state.seedLostClosed === true;
}

/** GV-113: an orphaned beat whose one writer round is spent and that is
 * still not carried: no note, and it keeps no seam open. The page still
 * names it as not carried (it is not settled). */
function orphanSpent(state: BeatState, round: number): boolean {
  return !state.carried && state.orphanedAt !== undefined && state.orphanedAt < round;
}

/** The beats a seam answers for: the ones positioned in it -- and, on the
 * streamed path, any a released seam handed to it (`settleReleased`). */
function beatsIn(seam: SeamState, beats: Map<string, BeatState>): BeatState[] {
  return [...beats.values()].filter((b) => b.seamId === seam.plan.seamId);
}

/**
 * GV-73: the act's verdict on the seams released early. A released seam is
 * judged with the act in the round it was released in, exactly as any
 * changed seam is; what differs is what a refusal does. The seam is NOT sent
 * back for editing, because it may already be playing: it is counted
 * (`releasedThenRefused`), keeps the verifier's note for the gate (F-51's
 * salvage), and the beats it was carrying are re-opened. Every unsettled
 * beat still positioned on a released seam -- refused, or confirmed with a
 * beat of its own missing -- is handed to the next seam that is not
 * released (else the nearest one before it), so `roundNotes` asks for it
 * there.
 */
function settleReleased(seams: SeamState[], beats: Map<string, BeatState>, round: number, actTitle: string, stats?: NarrationWriteStats): void {
  seams.forEach((seam, index) => {
    if (!seam.released) return;
    const seamId = seam.plan.seamId;
    if (seam.released.round === round && !seam.confirmed) {
      if (stats) stats.releasedThenRefused = (stats.releasedThenRefused ?? 0) + 1;
      console.warn(
        `writeAct: act "${actTitle}" — seam ${seamId} was released early (${seam.released.verifiedBy}) and the act's verifier then refused it; it is not edited, and its beats go to the next open seam: ${(seam.notes ?? "").slice(0, 200)}`
      );
      for (const state of beats.values()) {
        if (state.carriedBy !== seamId) continue;
        state.carried = false;
        delete state.carriedBy;
        delete state.verifiedAtAttempt;
      }
    }
    const target = seams.slice(index + 1).find((s) => !s.released) ?? [...seams.slice(0, index)].reverse().find((s) => !s.released);
    if (!target) return;
    for (const state of beats.values()) {
      if (state.seamId === seamId && !beatSettled(state)) state.seamId = target.plan.seamId;
    }
  });
}

/* ------------------------------------------------------------------ */
/* GV-73: the streamed round                                            */
/* ------------------------------------------------------------------ */

/** What a streamed round needs from the act. */
interface StreamRoundContext {
  round: number;
  act: SourcedAct;
  voice: Voice;
  seams: SeamState[];
  clips: ClipState[];
  clipById: Map<string, GateClip>;
  /** Clips with a held window, plus the ground pages. */
  clipSourceCount: number;
  ground: ReadonlyArray<GroundPageBrief>;
  documents: EvidenceDoc[];
  options: WriteActOptions;
}

/**
 * GV-73 (W4-10): one round's writer call, streamed. The reply arrives one
 * seam at a time (`writeActStream`, GV-43); the round returns every seam that
 * arrived and, when the stream stopped short (`length`: the token cap; or
 * stalled past the idle bound), the cut each missing seam is refused with.
 *
 * ROUND 1 CHECKS EACH SEAM AS ITS LINE CLOSES (`releaseProbe`), against the
 * act's sources so far: the clips' windows, the ground pages and the gated
 * claims of the seams already arrived. A seam that passes and carries no
 * claim and no beat -- line 1, the introduction `introOnlyFirstSeam` leaves
 * there -- is RELEASED: checked by code alone (the quote gate, the structural
 * rules, Q-02's naming and restate checks), signalled (`onSeamChecked`), and
 * frozen. A seam that carries claims is released only if the verifier's
 * optional `verifySeam` confirms it. Everything else waits, and the act-level
 * pass after the stream decides it exactly as on the one-shot path. The
 * incremental check never changes a seam it does not release: it runs on a
 * copy, so the act-level pass sees the seam as if nothing had looked at it.
 */
async function streamRound(request: ActWriteRequest, ctx: NarrationBuildContext, rc: StreamRoundContext): Promise<{ seams: WrittenSeam[]; cut?: StreamCut }> {
  const idleMs = rc.options.streamIdleTimeoutMs ?? DEFAULT_WRITER_STREAM_IDLE_MS;
  const arrived: WrittenSeam[] = [];
  const probe = rc.round === 1 ? releaseProbe(rc, ctx) : undefined;
  const probes: Array<Promise<void>> = [];
  const ended = await drainWriterStream(rc.options.writer.writeActStream!(request, ctx), idleMs, (seam, atMs) => {
    arrived.push(seam);
    if (probe) probes.push(probe(seam, atMs));
  });
  await Promise.all(probes);
  if (ended.stopReason === "length") return { seams: arrived, cut: { note: UNFINISHED_AT_CAP_NOTE } };
  if (ended.stopReason === "stalled") return { seams: arrived, cut: { note: `unfinished: the writer's stream stalled (nothing arrived for ${idleMs} ms)` } };
  return { seams: arrived };
}

/** GV-73: the incremental check of round 1, one arrived seam at a time. */
function releaseProbe(rc: StreamRoundContext, ctx: NarrationBuildContext): (written: WrittenSeam, atMs: number) => Promise<void> {
  const { options, round } = rc;
  const stats = options.stats;
  /* The gated claims of the seams already arrived (act sources for the
     seams after them), and the copies of those that cleared every rule. */
  const gatedSoFar = new Map<string, SelectedClaim[]>();
  const cleared = new Map<string, SeamState>();
  const probed = new Set<string>();
  const verifier = options.verifier as SeamVerifyingVerifier;
  return async (written, atMs) => {
    const seam = rc.seams.find((s) => s.plan.seamId === written.seamId);
    if (!seam || seam.frozen || seam.released || probed.has(seam.plan.seamId)) return;
    probed.add(seam.plan.seamId);
    const scratch: SeamState = { ...seam, attempts: [...seam.attempts] };
    const gated = gateSeamClaims(scratch, written, round);
    if (typeof gated === "string") return; // refused, or silent: nothing to release
    const others = [...gatedSoFar.values()].flat();
    gatedSoFar.set(seam.plan.seamId, gated.claims);
    const ownQuotes = gated.claims.map((c) => c.quote);
    const otherQuotes = others.map((c) => c.quote);
    const scope = (options.specifics ?? "report") === "enforce" ? actSpecificsScope(rc.seams, rc.clipById, [...otherQuotes, ...ownQuotes]) : undefined;
    const issues = validateSeam(scratch, gated, rc.clipById, round, {
      actSourceCount: rc.clipSourceCount + others.length,
      actSourceQuotes: otherQuotes,
      ...(scope ? { specifics: scope } : {}),
      ...(voiceEnforcedFor(options, ctx) ? { voice: true as const } : {})
    });
    if (issues.length > 0) return;
    cleared.set(seam.plan.seamId, scratch);

    let verifiedBy: "code" | "verifier" = "code";
    if (gated.claims.length > 0 || seam.plan.beats.length > 0) {
      if (typeof verifier.verifySeam !== "function") return;
      const sources = buildActSources([...cleared.values()], rc.clips, rc.ground, rc.documents);
      try {
        const verdict = await verifier.verifySeam(
          {
            actTitle: rc.act.title,
            voice: rc.voice,
            seam: verifySeamBriefOf(scratch, sources),
            beats: seam.plan.beats.map((b) => ({ beatId: b.beatId, claim: b.claim, mode: b.mode, kind: b.kind, ...(b.seedLost ? { seedLost: true as const } : {}) })),
            clips: rc.clips.map((c): VerifyClipBrief => ({ ...c.brief, windowText: c.windowText })),
            sources: sources.map((s) => s.brief),
            documents: rc.documents,
            ...(rc.ground.length > 0 ? { ground: [...rc.ground] } : {})
          },
          ctx
        );
        if (!verdict.confirmed) return;
      } catch (err) {
        console.warn(`writeAct: act "${rc.act.title}" — verifySeam failed for seam ${seam.plan.seamId}; it waits for the act's verifier (${err instanceof Error ? err.message : String(err)})`);
        return;
      }
      verifiedBy = "verifier";
    }

    Object.assign(seam, scratch, { released: { round, atMs, verifiedBy } });
    if (stats) {
      stats.seamsReleasedEarly = (stats.seamsReleasedEarly ?? 0) + 1;
      if (stats.firstSeamCheckedMs === undefined || atMs < stats.firstSeamCheckedMs) stats.firstSeamCheckedMs = atMs;
    }
    try {
      options.onSeamChecked?.({
        actIndex: options.actIndex ?? 0,
        seamId: seam.plan.seamId,
        script: seam.draft!.script,
        verifiedBy,
        ...(seam.plan.introduces ? { clipId: seam.plan.introduces.clipId } : {}),
        atMs
      });
    } catch (err) {
      console.warn(`writeAct: onSeamChecked threw for seam ${seam.plan.seamId}; ignored (${err instanceof Error ? err.message : String(err)})`);
    }
  };
}

/** GV-73: how a streamed reply ended. `stalled`: no event within the idle bound. */
export interface DrainedWriterStream {
  stopReason: "end" | "length" | "stalled";
  unfinishedSeamIds: string[];
}

const STALLED = Symbol("stalled");

/**
 * GV-73: drains a writer stream, handing each seam to `onSeam` as it
 * arrives, with an IDLE bound: the stream may run as long as it keeps
 * producing, and is abandoned (and asked to stop) once `idleMs` passes with
 * no event. A stream that finishes without its `end` event, or yields after
 * it, breaks GV-43's contract and throws, as `collectActStream` does.
 */
export async function drainWriterStream(
  stream: AsyncIterable<WriterStreamEvent>,
  idleMs: number,
  onSeam: (seam: WrittenSeam, atMs: number) => void
): Promise<DrainedWriterStream> {
  const iterator = stream[Symbol.asyncIterator]();
  let ended: Extract<WriterStreamEvent, { type: "end" }> | undefined;
  for (;;) {
    const next = await nextWithin(iterator, idleMs);
    if (next === STALLED) {
      try {
        const closing = iterator.return?.();
        if (closing) closing.catch(() => undefined);
      } catch {
        /* a stream that cannot be told to stop is abandoned all the same */
      }
      return { stopReason: "stalled", unfinishedSeamIds: [] };
    }
    if (next.done) break;
    const event = next.value;
    if (ended) throw new Error(`writeAct: the writer stream yielded a '${event.type}' event after its 'end' event`);
    if (event.type === "seam") onSeam(event.seam, event.atMs);
    else ended = event;
  }
  if (!ended) throw new Error("writeAct: the writer stream finished without an 'end' event");
  return { stopReason: ended.stopReason, unfinishedSeamIds: [...ended.unfinishedSeamIds] };
}

/** The iterator's next result, or STALLED when none arrives within `ms`. */
function nextWithin<T>(iterator: AsyncIterator<T>, ms: number): Promise<IteratorResult<T> | typeof STALLED> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const pending = iterator.next();
  pending.catch(() => undefined);
  const stalled = new Promise<typeof STALLED>((resolve) => {
    timer = setTimeout(() => resolve(STALLED), ms);
  });
  return Promise.race([pending, stalled]).finally(() => clearTimeout(timer));
}

/** The notes for the next round — empty when nothing failed. A seam's
 * own note goes on its SEAM line too (`seamBriefOf`); the act-level
 * list is F-35's running record. */
function roundNotes(seams: SeamState[], beats: Map<string, BeatState>, mechanical: string[], round: number): string[] {
  const notes: string[] = [...mechanical];
  for (const seam of seams) {
    /* GV-73: a released seam is never edited, so its refusal is no note. */
    if (!seam.draft || seam.confirmed || seam.frozen || seam.released) continue;
    if (seam.notes && seam.changed) notes.push(`seam ${seam.plan.seamId}: ${seam.notes}`);
  }
  for (const [beatId, state] of beats) {
    /* F-99: a seed-lost beat is NOT a note — there is nothing the writer
       can do with one, and asking is what cost run 9 three rounds a beat. */
    if (beatSettled(state)) continue;
    /* GV-113: an orphaned beat gets one writer round, never a second. */
    if (orphanSpent(state, round)) continue;
    const seam = seams.find((s) => s.plan.seamId === state.seamId)!;
    if (!seam.draft) continue; // its seam was refused in code; that note covers it
    /* GV-73: still on a released seam -- `settleReleased` found no open seam
       to hand it to, and no writer can edit the released one. */
    if (seam.released) continue;
    const beatNote = `the prose does not carry beat ${beatId} (${state.brief.claim.slice(0, 120)})${state.notes ? ` — ${state.notes}` : ""}; add it where it belongs (seam ${state.seamId}), resting on an act source — if nothing in the act supports it, say only what the sources say`;
    notes.push(beatNote);
    seam.notes = seam.notes ? `${seam.notes}; ${beatNote}` : beatNote;
  }
  return notes;
}

/* ------------------------------------------------------------------ */
/* Placement                                                            */
/* ------------------------------------------------------------------ */

/** The `WrittenAct`: one page per seam, placed on the seam's first
 * narration beat or on the clip it introduces; every other narration beat
 * of the seam points at the carrier; every beat comes out where it went
 * in. */
function assemble(act: SourcedAct, seams: SeamState[], beats: Map<string, BeatState>, cut?: CutPolicy): WrittenAct {
  const slots: WrittenSlot[] = act.slots.map((slot) => ({
    title: slot.title,
    beats: slot.beats.map((beat): WrittenBeat => {
      if (beat.sourcing === "tape") return { sourcing: "tape", claim: beat.claim, exploration: beat.exploration, tape: beat.tape };
      return { sourcing: "narration", claim: beat.claim, exploration: beat.exploration };
    })
  }));
  const at = (slot: number, beat: number): WrittenBeat => slots[slot]!.beats[beat]!;

  const pages = seams.map((seam) => finalPageFor(seam, beats, cut));
  /* GV-108: under `cut`, a seam whose page is gone or cut to its
     introduction no longer carries its beats. A beat of such a seam is still
     heard when the verifier said a clip, or a seam whose page plays whole,
     carries it; every other one is dropped. */
  const cutSeam = (index: number): boolean => {
    const page = pages[index];
    return cut !== undefined && (page === undefined ? seams[index]!.plan.beats.length > 0 : page.verification?.kind === "intro-only");
  };
  const heardIn = new Set<string>([
    ...(cut ? [...cut.clipById.keys()] : []),
    ...seams.filter((seam, index) => pages[index] !== undefined && !cutSeam(index)).map((seam) => seam.plan.seamId)
  ]);

  for (const [index, seam] of seams.entries()) {
    const page = pages[index];
    if (cutSeam(index)) {
      for (const b of seam.plan.beats) {
        const written = at(b.slot, b.beat);
        if (written.sourcing !== "narration") continue;
        const state = beats.get(b.beatId)!;
        if (state.carried && state.carriedBy !== undefined && heardIn.has(state.carriedBy)) {
          if (state.verifiedAtAttempt !== undefined) written.verifiedAtAttempt = state.verifiedAtAttempt;
          continue;
        }
        written.droppedReason = "unverified-cut";
      }
      /* The introduction plays just before its clip, as the clip's own
         connective narration (`stitchAct` emits it there). */
      if (page) {
        const clip = seam.plan.introduces!;
        const written = at(clip.slot, clip.beat);
        if (written.sourcing === "tape") written.connectiveNarration = page;
      }
      continue;
    }
    /* The page goes on the seam's first beat that plays AFTER the clip the
       seam follows -- on `planActSeams`' layout that is always its first
       beat. GV-73's `introOnlyFirstSeam` moves the first seam's beats past
       the first clip; those beats sit before it in the act, so they are
       carried by a beat after the clip, or, when the seam has none, by the
       next clip's connective narration -- the page plays between the two
       clips either way. */
    const follows = seam.plan.follows;
    const playsAfterFollows = (b: { slot: number; beat: number }): boolean => !follows || b.slot > follows.slot || (b.slot === follows.slot && b.beat > follows.beat);
    const carrier = seam.plan.beats.find(playsAfterFollows) ?? (seam.plan.introduces ? undefined : seam.plan.beats[0]);
    const holder = carrier ?? seam.plan.introduces;
    for (const b of seam.plan.beats) {
      const written = at(b.slot, b.beat);
      if (written.sourcing !== "narration") continue;
      const state = beats.get(b.beatId)!;
      if (state.verifiedAtAttempt !== undefined) written.verifiedAtAttempt = state.verifiedAtAttempt;
      if (holder && b !== carrier) written.carriedBy = { slot: holder.slot, beat: holder.beat };
    }
    if (!page) {
      if (seam.plan.beats.length > 0) {
        /* Unreachable by construction — `finalPageFor` always returns a
           page for a seam with beats — and pinned so a beat can never
           silently lose its page. */
        throw new Error(`writeActNarration: seam ${seam.plan.seamId} carries beats but produced no page`);
      }
      continue;
    }
    if (carrier) {
      const written = at(carrier.slot, carrier.beat);
      if (written.sourcing === "narration") written.narration = page;
      continue;
    }
    const clip = seam.plan.introduces!;
    const written = at(clip.slot, clip.beat);
    if (written.sourcing === "tape") written.connectiveNarration = page;
  }

  return { title: act.title, slots };
}

/** The page a seam leaves behind: its confirmed text with every positioned
 * beat carried — verified, in the mode its sources decide; else (F-51) the
 * last mechanically clean draft, unverified, with the final objection;
 * else the last page produced at all; else, for a seam with beats, the
 * `no-page` hand-off; and nothing for a silent seam or an intro-only seam
 * that FAILED. The evidence carried is the documents the page cites plus
 * the windows of the clips on either side, so `groundedQuoteRate`
 * resolves every quote and the report's restate check has the clip's
 * opening. */
function finalPageFor(seam: SeamState, beats: Map<string, BeatState>, cut?: CutPolicy): NarratedBeat | undefined {
  const hasBeats = seam.plan.beats.length > 0;
  const uncarried = seam.plan.beats.filter((b) => !beatSettled(beats.get(b.beatId)!)).map((b) => b.beatId);
  /* F-99: the beats closed as seed-lost — not "the writer missed them",
     but "the tape their claim was written from is not in this Foray". */
  const seedLost = seam.plan.beats.filter((b) => beats.get(b.beatId)!.seedLostClosed === true).map((b) => b.beatId);

  if (seam.confirmed && seam.draft) {
    const { sources, rest, pageIds, notes } = seam.confirmed;
    const verification: SynthesisVerification | undefined = pageIds.length > 0 ? { kind: "synthesis", restsOn: pageIds, attempt: seam.confirmed.round } : undefined;
    const settled = uncarried.length === 0 && seedLost.length === 0;
    const page: NarratedBeat = {
      mode: assignSeamMode(seam.plan, rest),
      script: seam.draft.script,
      sources,
      pronunciationHints: seam.draft.hints,
      verified: settled,
      purposeAccomplished: settled,
      ...(verification ? { verification } : {}),
      attempts: seam.attempts,
      /* GV-113: the sentences the cut removed, only when it made one. */
      ...(seam.draft.cut ? { cutSentences: [...seam.draft.cut.sentences] } : {})
    };
    const evidence = evidenceCarriedBy(seam, page);
    if (settled) return { ...page, ...(notes ? { verifierNotes: notes } : {}), evidence };
    /* GV-108: confirmed text with a beat of its own not carried (or lost
       with its seed) is a failing seam like any other under `cut`. */
    if (cut) {
      const missing = [...uncarried, ...seedLost];
      return cutToIntroduction(seam, seam.draft.script, seam.draft.hints, cut, `beat${missing.length > 1 ? "s" : ""} ${missing.join(", ")} not carried`, seam.draft.cut?.sentences);
    }
    /* F-99: the seam is clean and confirmed and the ONLY thing missing is
       a beat whose seed is gone. A distinct reason, not an ordinary
       refusal: nothing was retried, and nothing can be — the editor's
       move is to re-seed the beat or cut it. */
    if (uncarried.length === 0) {
      const note = `beat${seedLost.length > 1 ? "s" : ""} ${seedLost.join(", ")} ${seedLost.length > 1 ? "were" : "was"} seeded from tape this Foray never clipped (seedLost, F-96) and the act's sources do not carry ${seedLost.length > 1 ? "them" : "it"} — the prose says only what the sources say; re-seed the beat or cut it (F-99, uncarried: seed-lost)`;
      console.warn(`writeAct: seam ${seam.plan.seamId} — ${note.slice(0, 220)}`);
      return { ...page, unverifiedReason: "seed-lost", verifierNotes: note, evidence };
    }
    const note =
      `beat${uncarried.length > 1 ? "s" : ""} ${uncarried.join(", ")} positioned in this seam ${uncarried.length > 1 ? "are" : "is"} not carried${uncarried.map((id) => beats.get(id)!.notes).filter(Boolean).length > 0 ? ` — ${uncarried.map((id) => beats.get(id)!.notes).filter(Boolean).join("; ")}` : ""}` +
      (seedLost.length > 0 ? `; beat${seedLost.length > 1 ? "s" : ""} ${seedLost.join(", ")} lost ${seedLost.length > 1 ? "their seeds" : "its seed"} (F-99, uncarried: seed-lost)` : "");
    console.warn(
      `writeAct: keeping seam ${seam.plan.seamId} (${seam.plan.beats.map((b) => b.beatId).join(", ")}) UNVERIFIED after ${seam.attempts.length} attempt(s) — the veracity gate decides (F-51): ${note.slice(0, 200)}`
    );
    return { ...page, verifierNotes: note, evidence };
  }
  if (seam.silent) return undefined;

  const salvage = seam.kept?.page ?? seam.lastPage;
  const notes = (seam.kept?.notes ?? seam.notes ?? seam.attempts[seam.attempts.length - 1]?.rejectionNote ?? "").trim();
  if (salvage) {
    /* GV-108: the verifier never confirmed this seam -- keep only its
       introduction, or nothing. */
    if (cut) return cutToIntroduction(seam, salvage.script, salvage.pronunciationHints, cut, notes || "never confirmed");
    if (!hasBeats) {
      console.warn(
        `writeAct: dropping the introduction before clip ${seam.plan.introduces?.clipId ?? "?"} (seam ${seam.plan.seamId}) after ${seam.attempts.length} rejected attempt(s) — clips run together, silence bridges (${notes.slice(0, 200)})`
      );
      return undefined;
    }
    console.warn(
      `writeAct: keeping seam ${seam.plan.seamId} (${seam.plan.beats.map((b) => b.beatId).join(", ")}) UNVERIFIED after ${seam.attempts.length} attempt(s) — the veracity gate decides (F-51): ${notes.slice(0, 200)}`
    );
    const rest: SeamRest = { print: salvage.sources.some((s) => !isTapeSource(s)), tape: salvage.sources.some((s) => isTapeSource(s)) };
    const page: NarratedBeat = {
      ...salvage,
      mode: assignSeamMode(seam.plan, rest),
      verified: false,
      purposeAccomplished: false,
      ...(notes ? { verifierNotes: notes } : {}),
      attempts: seam.attempts
    };
    return { ...page, evidence: evidenceCarriedBy(seam, page) };
  }
  if (!hasBeats) return undefined;
  /* GV-108: no text at all, so nothing to cut to -- and the hand-off line is
     never produced under `cut`. */
  if (cut) {
    console.warn(
      `writeAct: no page was ever produced for seam ${seam.plan.seamId} (${seam.plan.beats.map((b) => b.beatId).join(", ")}) — dropping it, no hand-off (FORAY_UNVERIFIED_SEAM_POLICY=cut, GV-108): ${notes.slice(0, 200)}`
    );
    return undefined;
  }
  console.warn(
    `writeAct: no page was ever produced for seam ${seam.plan.seamId} (${seam.plan.beats.map((b) => b.beatId).join(", ")}) — keeping an unverified hand-off in its place (F-51/F-60): ${notes.slice(0, 200)}`
  );
  const page: NarratedBeat = {
    mode: HANDOFF_MODE,
    script: HANDOFF_SCRIPT,
    sources: [],
    pronunciationHints: [],
    verified: false,
    unverifiedReason: "no-page",
    verifierNotes: notes || "no page was produced",
    attempts: seam.attempts
  };
  return { ...page, evidence: evidenceCarriedBy(seam, page) };
}

/* ------------------------------------------------------------------ */
/* GV-113: cut unsupported sentences instead of rewriting               */
/* ------------------------------------------------------------------ */

/** What the sentence cut needs from the act (FORAY_UNSUPPORTED_SENTENCE_POLICY
 * =cut): the seams (for the act's source set as the mechanical gate counts
 * it), the clips, and the gates this act enforces, so a trimmed seam faces
 * every rule its writer's text did. */
interface SentenceCutContext {
  seams: SeamState[];
  clipById: Map<string, GateClip>;
  clipSourceCount: number;
  specifics: SpecificsMode;
  voiceEnforce: boolean;
}

/** The note a trimmed seam's page carries (`verifierNotes`), with the round
 * of the cut, so an editor reads why sentences are missing. */
export const SENTENCE_CUT_NOTE = "unsupported sentence(s) cut (FORAY_UNSUPPORTED_SENTENCE_POLICY=cut, GV-113)";

/** Words that lean on what came before: a kept first sentence that opens on
 * one after the sentence before it was cut may dangle ("That is why ..."). */
const LEANING_OPENERS = /^["'“‘(]*(that|this|these|those|it|its|they|their|them|he|she|his|her|such|so|then|but|and|which)\b/i;

/**
 * GV-113 (W5-11; R2-10): the act verifier's per-sentence verdicts applied in
 * CODE instead of a rewrite round. When some, but not all, of the seam's
 * statement sentences are `unsupported`, the seam is trimmed to its other
 * sentences (their original text, spokenLine.js's `splitSpokenSentences`, in
 * order), its claims are pruned to the ones a surviving statement rests on,
 * and the trimmed seam is put through `validateSeam` again with the floor of
 * its band relaxed to 0 (a cut seam may be shorter than seamBand asks; every
 * other rule still runs: Q-02/Q-09 naming, the restate check, Q-08 leaks,
 * banned copy, and the voice and specifics gates where they enforce). It is
 * then confirmed resting on what its surviving statements rest on, under the
 * same F-36/F-37 and contested rules `judge` holds a whole seam to.
 *
 * Commits the trimmed draft (with `cut`) and returns the resolved sources,
 * the cut sentences' indexes and the page note; returns undefined, changing
 * nothing, when the policy does not apply or the trimmed seam fails, so the
 * existing (rewrite) path runs: every statement unsupported, a surviving
 * statement the judge could not answer (`unknown`), verdicts that do not line
 * up with the script's sentences, an unhandled contested point, or a rule.
 */
function cutUnsupportedSentences(
  seam: SeamState,
  verdict: SeamVerdict,
  actSources: ActSource[],
  round: number,
  actTitle: string,
  ctx: SentenceCutContext
): { resolved: ReturnType<typeof sourcesForRest>; indexes: Set<number>; note: string } | undefined {
  const draft = seam.draft;
  const verdicts = verdict.sentences;
  if (!draft || !verdicts || !verdict.contestedHandled) return undefined;
  const sentences = splitSpokenSentences(draft.script);
  const statements = verdicts.filter((v) => v.kind === "statement");
  const indexes = new Set(statements.filter((v) => v.verdict === "unsupported").map((v) => v.index));
  if (indexes.size === 0 || indexes.size === statements.length) return undefined;
  const seamId = seam.plan.seamId;
  if (verdicts.length !== sentences.length || verdicts.some((v, i) => v.index !== i)) {
    console.warn(`writeAct: act "${actTitle}" seam ${seamId} — the sentence verdicts do not line up with the script's ${sentences.length} sentence(s); not cutting (GV-113)`);
    return undefined;
  }
  if (statements.some((v) => !indexes.has(v.index) && v.verdict !== "supported")) return undefined;

  const kept = sentences.filter((_, i) => !indexes.has(i));
  const cutSentences = sentences.filter((_, i) => indexes.has(i));
  const script = kept.join(" ");
  const restsOn: string[] = [];
  for (const v of statements) if (!indexes.has(v.index)) for (const id of v.restsOn ?? []) if (!restsOn.includes(id)) restsOn.push(id);
  const own = actSources.filter((s) => s.brief.selectedBy === seamId);
  const keepClaims = new Set(own.filter((s) => restsOn.includes(s.brief.id)).map((s) => s.claimIndex));
  const claims = draft.claims.filter((_, i) => keepClaims.has(i));

  /* What the trimmed seam rests on: its surviving statements' sources, else
     its surviving claims (as `judge` falls back to a seam's own). */
  const ids = restsOn.length > 0 ? restsOn : own.filter((s) => keepClaims.has(s.claimIndex)).map((s) => s.brief.id);
  const resolved = sourcesForRest(ids, actSources);
  if (resolved.sources.length === 0 && resolved.pageIds.length === 0 && hasDeclarativeSentence(script)) return undefined;
  const rested = actSources.filter((s) => ids.includes(s.brief.id));
  if (rested.some((s) => s.brief.contested) && !containsContestedLanguage(script)) return undefined;

  /* The mechanical rules, on a copy: a refusal leaves the seam as it was. */
  const others = ctx.seams.filter((s) => s !== seam).flatMap((s) => s.draft?.claims ?? []);
  const scope = ctx.specifics === "enforce" ? actSpecificsScope(ctx.seams, ctx.clipById, [...others, ...claims].map((c) => c.quote)) : undefined;
  const canon = script.toLowerCase();
  const hints = draft.hints.filter((h) => canon.includes(h.word.toLowerCase()));
  const scratch: SeamState = { ...seam, attempts: [...seam.attempts] };
  const issues = validateSeam(scratch, { script, claims, hints }, ctx.clipById, round, {
    actSourceCount: ctx.clipSourceCount + others.length,
    actSourceQuotes: others.map((c) => c.quote),
    ...(scope ? { specifics: scope } : {}),
    ...(ctx.voiceEnforce ? { voice: true as const } : {}),
    charBandOverride: [0, seam.band[1]]
  });
  if (issues.length > 0 || !scratch.draft) {
    console.warn(`writeAct: act "${actTitle}" seam ${seamId} — trimmed of ${cutSentences.length} unsupported sentence(s), it fails in code; the writer is asked instead (GV-113): ${issues.join("; ").slice(0, 300)}`);
    return undefined;
  }

  seam.draft = { ...scratch.draft, cut: { sentences: cutSentences, round } };
  if (scratch.kept) seam.kept = scratch.kept;
  if (scratch.lastPage) seam.lastPage = scratch.lastPage;
  seam.previousScript = script;
  if (indexes.has(0) && LEANING_OPENERS.test(kept[0] ?? "")) {
    console.warn(`writeAct: act "${actTitle}" seam ${seamId} — after the cut its first sentence leans on one that is gone ("${(kept[0] ?? "").slice(0, 80)}") (GV-113)`);
  }
  console.warn(
    `writeAct: act "${actTitle}" seam ${seamId} — cut ${cutSentences.length} unsupported sentence(s) in round ${round} instead of asking the writer again, ${kept.length} kept (FORAY_UNSUPPORTED_SENTENCE_POLICY=cut, GV-113)`
  );
  return { resolved, indexes, note: `${cutSentences.length} ${SENTENCE_CUT_NOTE}, round ${round}` };
}

/**
 * GV-113 (MQ-11): beat coverage after a cut, decided in code. A beat this
 * round's verdict said the trimmed seam carries is re-opened when the
 * sentence that carried it (`carriedBySentence`) was cut, or, with no
 * sentence named, when the trimmed script no longer shares a content word
 * with its claim (`scriptIsAboutPurpose`, the stub verifier's structural
 * test). An orphaned beat earns the seam ONE more writer round (its note
 * names the beat); the trimmed state is kept so it can stand after it.
 */
function reopenOrphans(seam: SeamState, cut: Set<number>, open: BeatState[], verdicts: ActVerifyResult, round: number, actTitle: string): void {
  const seamId = seam.plan.seamId;
  const orphaned: string[] = [];
  for (const state of open) {
    if (!state.carried || state.carriedBy !== seamId) continue;
    const at = verdicts.beats.find((v) => v.beatId === state.brief.beatId)?.carriedBySentence;
    const lost = at !== undefined && at.seamId === seamId ? cut.has(at.index) : !scriptIsAboutPurpose(seam.draft!.script, state.brief.claim);
    if (!lost) continue;
    state.carried = false;
    delete state.carriedBy;
    delete state.restsOn;
    delete state.verifiedAtAttempt;
    state.notes = "the sentence that carried it was cut as unsupported (GV-113)";
    /* A seam that already spent its one edit round earns nothing more: a
       beat it orphans now is stamped with that round, so it is spent at once
       (no note, keeps no seam open) and the seam freezes. */
    state.orphanedAt ??= seam.orphanEdit ? seam.orphanEdit.round : round;
    orphaned.push(state.brief.beatId);
  }
  if (orphaned.length === 0) return;
  console.warn(`writeAct: act "${actTitle}" seam ${seamId} — the cut left beat(s) ${orphaned.join(", ")} uncarried (GV-113)`);
  if (seam.orphanEdit) return;
  seam.orphanEdit = {
    round,
    state: { draft: seam.draft, confirmed: seam.confirmed, kept: seam.kept, lastPage: seam.lastPage, previousScript: seam.previousScript },
    carried: open
      .filter((b) => b.carried && b.carriedBy === seamId)
      .map((b) => ({
        beatId: b.brief.beatId,
        carriedBy: b.carriedBy,
        ...(b.restsOn ? { restsOn: b.restsOn } : {}),
        ...(b.verifiedAtAttempt !== undefined ? { verifiedAtAttempt: b.verifiedAtAttempt } : {})
      }))
  };
}

/**
 * GV-113: the end of an orphan edit round. A seam that earned one writer
 * round by a cut in the previous round and is not confirmed now gets the
 * trimmed, confirmed state back, with the beats it carried: the trimmed
 * text stands, and its orphaned beat is left to the unverified-seam policy.
 * Returns the seams put back, whose refusals this round are no note.
 */
function holdOrphanEdits(seams: SeamState[], beats: Map<string, BeatState>, round: number, actTitle: string): Set<string> {
  const held = new Set<string>();
  for (const seam of seams) {
    const edit = seam.orphanEdit;
    if (!edit || edit.round !== round - 1 || (seam.confirmed && seam.draft)) continue;
    Object.assign(seam, edit.state);
    delete seam.notes;
    delete seam.silent;
    /* A beat the refused text carried is not carried by the text that stands. */
    for (const state of beats.values()) {
      if (!state.carried || state.carriedBy !== seam.plan.seamId || edit.carried.some((c) => c.beatId === state.brief.beatId)) continue;
      state.carried = false;
      delete state.carriedBy;
      delete state.restsOn;
      delete state.verifiedAtAttempt;
    }
    for (const kept of edit.carried) {
      const state = beats.get(kept.beatId);
      if (!state || state.carried) continue;
      state.carried = true;
      if (kept.carriedBy !== undefined) state.carriedBy = kept.carriedBy;
      if (kept.restsOn) state.restsOn = kept.restsOn;
      if (kept.verifiedAtAttempt !== undefined) state.verifiedAtAttempt = kept.verifiedAtAttempt;
      delete state.notes;
    }
    held.add(seam.plan.seamId);
    console.warn(`writeAct: act "${actTitle}" seam ${seam.plan.seamId} — its one edit round after the cut was not confirmed; the trimmed text stands (GV-113)`);
  }
  return held;
}

/* ------------------------------------------------------------------ */
/* GV-108: the cut-to-introduction policy                               */
/* ------------------------------------------------------------------ */

/** What `cutToIntroduction` needs from the act: its clips (show, episode
 * title, opening and window), and the gates this act enforces, so a cut
 * page never carries what the writer would have been re-asked for. */
interface CutPolicy {
  clipById: Map<string, GateClip>;
  /** GV-104: the voice gate enforces on this act. */
  voiceEnforce: boolean;
  /** GV-34: the specifics gate's mode. */
  specifics: SpecificsMode;
}

/** The note an intro-only page carries, so an editor reading the act sees
 * why the seam's other sentences are gone. */
export const INTRO_CUT_NOTE = "cut to its introduction (FORAY_UNVERIFIED_SEAM_POLICY=cut, GV-108)";

/**
 * GV-108 (W5-12b; R2-13): a failing seam's text cut to its introduction.
 * Keeps, in order, the sentences (spokenLine.js's `splitSpokenSentences`,
 * GV-10) that
 *   - name the clip's show or someone its episode title names
 *     (`introNamesSource`, Q-02),
 *   - repeat none of the clip's first sentences (`introRestatesClip`),
 *   - mention none of this Foray's own structure (`narratorStructureLeaks`,
 *     Q-08),
 *   - break no spoken-line rule when the voice gate enforces on this act
 *     (GV-104), and state no number, year or name the clips' windows do not
 *     carry when the specifics gate enforces (GV-34),
 * up to the Intro band's ceiling. The page that is left rests on the clip it
 * introduces (a tape source, the window as its document), is `verified` with
 * `verification: {kind: "intro-only", clipId}`, and lists the rest as
 * `cutSentences`. It must still do what the seam's introduction owed: a full
 * introduction to a show's first clip says the show's name (Q-09), and the
 * page clears the structural validator in the Intro band.
 *
 * Undefined -- no page, the clips run together -- for a seam that introduces
 * no clip, or when no sentence survives or the survivors fail a rule. A clip
 * whose window the act does not hold is still the page's source (named by
 * its source row, which is all the naming check reads), as the introduction
 * the writer owed it would have been. Intro sentences
 * pass a naming check only, not a support check (GV-120 and GV-121 add
 * those).
 */
function cutToIntroduction(
  seam: SeamState,
  script: string,
  hints: NarratedBeat["pronunciationHints"],
  cut: CutPolicy,
  why: string,
  /** GV-113: sentences a sentence cut already removed from `script`; they
   * lead the page's `cutSentences`. */
  alreadyCut: readonly string[] = []
): NarratedBeat | undefined {
  const drop = (reason: string): undefined => {
    console.warn(
      `writeAct: dropping seam ${seam.plan.seamId} (${seam.plan.beats.map((b) => b.beatId).join(", ") || "intro only"}) after ${seam.attempts.length} attempt(s), ${reason} — clips run together (FORAY_UNVERIFIED_SEAM_POLICY=cut, GV-108): ${why.slice(0, 200)}`
    );
    return undefined;
  };
  const introduces = seam.plan.introduces;
  if (!introduces) return drop("it introduces no clip");
  const clip = cut.clipById.get(introduces.clipId);
  if (!clip) return drop(`clip ${introduces.clipId} is not in the act`);
  const { brief, window } = clip;

  /* The texts a kept sentence's specifics may rest on: the windows the page
     carries as evidence (the clip it introduces and the clip before it). */
  const follows = seam.plan.follows ? cut.clipById.get(seam.plan.follows.clipId) : undefined;
  const specificsTexts = cut.specifics === "enforce" ? [window?.text ?? "", follows?.window?.text ?? ""].filter((t) => t.length > 0) : [];
  const allowNames = [brief.show, brief.title, follows?.brief.show ?? "", follows?.brief.title ?? ""].filter((n) => n.trim().length > 0);
  const introMax = MODE_CHAR_BANDS.Intro[1];

  const kept: string[] = [];
  const cutSentences: string[] = [...alreadyCut];
  for (const sentence of splitSpokenSentences(script)) {
    const keeps =
      introNamesSource(sentence, brief) &&
      !introRestatesClip(sentence, brief.opening).restates &&
      narratorStructureLeaks(sentence).length === 0 &&
      (!cut.voiceEnforce || voiceReport(sentence, { hasTape: true }).hardErrors.length === 0) &&
      (cut.specifics !== "enforce" || unsupportedSpecificsInScript(sentence, specificsTexts, { allowNames }).length === 0) &&
      [...kept, sentence].join(" ").length <= introMax;
    (keeps ? kept : cutSentences).push(sentence);
  }
  const intro = kept.join(" ");
  if (intro.length === 0) return drop("no sentence of it is an introduction that passes in code");
  /* Q-09, as `validateSeam` holds it: a full introduction to the first clip
     this Foray plays from a show says the show's name. */
  if (seam.intro === "full" && brief.show.trim().length > 0 && brief.showFirstHeard !== false && !introNamesShow(intro, brief)) {
    return drop(`its introduction never says the name of "${brief.show}" (Q-09)`);
  }
  /* A run of words can straddle two kept sentences. */
  if (introRestatesClip(intro, brief.opening).restates) return drop("its introduction repeats the clip's first sentences (Q-02)");

  const source: TapeSource = {
    kind: "tape",
    segmentId: brief.segmentId,
    claimText: `the clip that follows is from ${brief.show || "the show"}: "${brief.title}"`,
    /* The window's own title when the act holds it (the attribution rule
       reads it off the document); else the source row's show and episode,
       which is all the naming check read. */
    publication: window?.title ?? ([brief.show, brief.title].filter((t) => t.trim().length > 0).join(" — ") || brief.segmentId),
    contested: false
  };
  const verification: IntroOnlyVerification = { kind: "intro-only", clipId: brief.clipId };
  const canonIntro = intro.toLowerCase();
  const page: NarratedBeat = {
    mode: "Intro",
    script: intro,
    sources: [source],
    pronunciationHints: hints.filter((h) => canonIntro.includes(h.word.toLowerCase())),
    verified: true,
    verifierNotes: `${INTRO_CUT_NOTE}: ${why}`.slice(0, 600),
    attempts: seam.attempts,
    verification,
    ...(cutSentences.length > 0 ? { cutSentences } : {})
  };
  /* With the window held, the tape source is checked against it (the
     window is a held document, the publication its title); without one only
     the rules that need no document run, as for any page without one. */
  const structural = validateNarratedBeat(page, {
    bannedPhrasePatterns: BANNED,
    ...(window ? { heldDocs: heldDocsOf(seam.gate.evidence) } : {}),
    charBand: MODE_CHAR_BANDS.Intro,
    tapeCitable: true
  });
  if (!structural.valid) return drop(`its introduction fails the structural rules (${structural.issues.map((i) => i.message).join("; ").slice(0, 200)})`);
  console.warn(
    `writeAct: cutting seam ${seam.plan.seamId} (${seam.plan.beats.map((b) => b.beatId).join(", ") || "intro only"}) to its introduction before clip ${brief.clipId} — ${kept.length} sentence(s) kept, ${cutSentences.length - alreadyCut.length} cut (FORAY_UNVERIFIED_SEAM_POLICY=cut, GV-108): ${why.slice(0, 200)}`
  );
  return { ...page, evidence: evidenceCarriedBy(seam, page) };
}

function evidenceCarriedBy(seam: SeamState, page: NarratedBeat): HeldEvidenceDoc[] {
  const cited = new Set<string>();
  for (const source of page.sources) {
    const doc = seam.gate.evidence.docs.find((d) => d.title === source.publication || ("url" in source && source.url !== undefined && d.url === source.url));
    if (doc) cited.add(doc.docId);
    if ("segmentId" in source) cited.add(tapeDocIdFor(source.segmentId));
  }
  if (seam.plan.follows) cited.add(tapeDocIdFor(seam.plan.follows.tape.segmentId));
  if (seam.plan.introduces) cited.add(tapeDocIdFor(seam.plan.introduces.tape.segmentId));
  return heldDocsOf({ ...seam.gate.evidence, docs: seam.gate.evidence.docs.filter((d) => cited.has(d.docId)) });
}
