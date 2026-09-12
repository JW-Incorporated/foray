import { BANNED } from "../copy/rules";
import { decodeEntities } from "../feeds/html";
import type { SourcedAct } from "../types/tapeSourcing";
import type { Voice } from "../types/spine";
import {
  hasDeclarativeSentence,
  isTapeSource,
  tapeDocIdFor,
  validateNarratedBeat,
  type EvidenceDoc as HeldEvidenceDoc,
  type NarratedBeat,
  type NarrationAttemptRecord,
  type NarrationMode,
  type Source,
  type SynthesisVerification
} from "../types/narration";
import type { EvidenceDoc, EvidenceGatherer, EvidencePack } from "./gatherEvidence";
import type {
  ActWriteRequest,
  ActWriteResult,
  BeatBrief,
  ClipBrief,
  GroundPageBrief,
  IntroKind,
  NarrationBuildContext,
  NarrationWriterBuilder,
  SeamBrief,
  SelectedClaim,
  WrittenSeam
} from "./NarrationWriterBuilder";
import type { ActSourceBrief, ActVerifyResult, NarrationVerifierBuilder, VerifyClipBrief, VerifySeamBrief } from "./NarrationVerifierBuilder";
import {
  actBeatsInOrder,
  assignSeamMode,
  clipDurationSec,
  clipOpening,
  decideIntro,
  introNamesSource,
  introRestatesClip,
  planActSeams,
  seamBand,
  seamMode,
  type SeamClip,
  type SeamPlan,
  type SeamRest
} from "./actSeams";
import { pageDocIdFor } from "./synthesisVerify";
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
  type NarrationWriteStats,
  type PendingPage,
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
 *
 * COST. A clean act is two requests (write, verify). A round is at most
 * two more (the writer, then the verifier if anything clean is
 * unconfirmed), so an act costs at most six. The deck's target —
 * `narrationCallsPerAct` ≤ 3 — is met on a clean pass.
 */

export interface WriteActOptions {
  writer: NarrationWriterBuilder;
  verifier: NarrationVerifierBuilder;
  evidence: EvidenceGatherer;
  stats?: NarrationWriteStats;
  segmentSources?: ReadonlyArray<{ id: string; show: string; title: string }>;
  /** F-97: F-88's ground — the verified pages of the acts already landed. */
  ground?: ReadonlyArray<GroundPageBrief>;
}

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
  draft?: { script: string; claims: SelectedClaim[]; page: NarratedBeat; hints: NarratedBeat["pronunciationHints"] };
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
}

interface BeatState {
  brief: BeatBrief;
  seamId: string;
  carried: boolean;
  carriedBy?: string;
  restsOn?: string[];
  verifiedAtAttempt?: number;
  notes?: string;
}

/** One entry of the act's source set, with what it resolves to. */
interface ActSource {
  brief: ActSourceBrief;
  /** A claim's or a clip's source shape; absent for a ground page. */
  source?: Source;
  /** A ground page's Foray-wide id. */
  pageId?: string;
}

export async function writeActNarration(act: SourcedAct, options: WriteActOptions, voice: Voice, ctx: NarrationBuildContext): Promise<WrittenAct> {
  const { writer, verifier, evidence, stats } = options;
  if (!writer.writeAct || !verifier.verifyAct) {
    throw new Error("writeActNarration: the writer and verifier must both offer the per-act contract (writeAct / verifyAct)");
  }
  const ground = options.ground ?? [];

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

  /* 2. THE CLIPS, in play order, each with its opening and its Intro
        weight (Q-02). */
  const seamPlans = planActSeams(act);
  const clips: ClipState[] = [];
  let previousClip: SeamClip | undefined;
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
        intro: decideIntro(clip.tape, previousClip?.tape, opening)
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
      beats.set(b.beatId, { brief: { beatId: b.beatId, claim: b.claim, mode: b.mode, kind: b.kind }, seamId: seam.plan.seamId, carried: false });
    }
  }

  /* 4. ROUNDS — at most `NARRATION_PAGE_ATTEMPTS` per act. */
  const actRejections: string[] = [];
  for (let round = 1; round <= NARRATION_PAGE_ATTEMPTS; round++) {
    if (round > 1 && stats) stats.retryRounds += 1;

    const reply = await writer.writeAct(
      {
        actTitle: act.title,
        voice,
        seams: seams.map(seamBriefOf),
        clips: clips.map((c) => c.brief),
        documents,
        ...(ground.length > 0 ? { ground: [...ground] } : {}),
        ...(actRejections.length > 0 ? { retryNote: retryNoteFrom(actRejections) } : {})
      },
      ctx
    );

    /* THE MECHANICAL GATE, seam by seam, in two passes (`mechanicalPass`):
       first every seam's claims through the quote gate (the act's source
       set is the union of what survives), then every seam's script through
       the structural rules against that set. A frozen seam is not re-read:
       its text is kept whatever the writer returned. */
    const mechanical = mechanicalPass(seams, reply, clipById, clips.filter((c) => c.window).length + ground.length, round, act.title);
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
    const open = [...beats.values()].filter((b) => !b.carried && hasScript(b.seamId));
    if (toJudge.length > 0) {
      const verdicts = await verifier.verifyAct(
        {
          actTitle: act.title,
          voice,
          beats: open.map((b) => b.brief),
          seams: seams.filter((s) => s.draft).map((s) => verifySeamBriefOf(s, actSources)),
          clips: clips.map((c): VerifyClipBrief => ({ ...c.brief, windowText: c.windowText })),
          sources: actSources.map((s) => s.brief),
          ...(ground.length > 0 ? { ground: [...ground] } : {}),
          documents
        },
        ctx
      );
      judge(toJudge, open, verdicts, actSources, round);
    }

    /* WHAT FAILED: a seam refused in code, a seam the verifier refused, a
       seam whose positioned beat is not carried anywhere. Everything else
       is frozen from here on. */
    const notes = roundNotes(seams, beats, mechanical);
    for (const seam of seams) {
      if (seam.draft && seam.confirmed && seam.plan.beats.every((b) => beats.get(b.beatId)!.carried)) {
        seam.frozen = true;
        delete seam.notes;
      } else if (seam.confirmed && seam.draft) {
        /* Confirmed text, but a beat of its own is missing: open it for
           editing. The confirmation stands if the writer leaves it alone. */
        seam.frozen = false;
      }
    }
    if (notes.length === 0) break;
    actRejections.push(notes.join(" | "));
  }

  return assemble(act, seams, beats);
}

/* ------------------------------------------------------------------ */
/* The round's parts                                                    */
/* ------------------------------------------------------------------ */

function positionKey(slot: number, beat: number): string {
  return `${slot}/${beat}`;
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
      rejections: [],
      attempts: [],
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
 */
function mechanicalPass(seams: SeamState[], reply: ActWriteResult, clipById: Map<string, GateClip>, clipSourceCount: number, round: number, actTitle: string): string[] {
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
  for (const seam of seams) {
    const p = pending.get(seam.plan.seamId);
    if (!p) continue;
    const issues = validateSeam(seam, p, clipById, round, {
      actSourceCount: clipSourceCount + totalClaims - p.claims.length,
      actSourceQuotes: quotesOf(seam.plan.seamId)
    });
    if (issues.length > 0) mechanical.push(`seam ${seam.plan.seamId}: ${issues.join("; ")}`);
  }
  return mechanical;
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
      tape: { segmentId: brief.segmentId, itemId: brief.itemId, startSec: 0, endSec: brief.durationSec, startAnchor: "", endAnchor: "", tier: 1, confidence: "high" }
    };
  };
  const seams = request.seams.map((brief) =>
    seamStateOf(
      {
        seamId: brief.seamId,
        beats: brief.beats.map((b) => ({ slot: 0, beat: 0, beatId: b.beatId, claim: b.claim, mode: b.mode === "Carry" ? "Carry" : "Patch", kind: b.kind, exploration: false })),
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
  for (const pack of packs) {
    for (const doc of pack.docs) {
      if (out.has(doc.docId)) continue;
      const { tapePosition: _position, ...rest } = doc;
      out.set(doc.docId, rest);
    }
  }
  return [...out.values()];
}

/** F-88's ground as the writer's documents — the same shape
 * `synthesisVerify.ts`'s `pageDocsFor` hands the synthesis writer, so a
 * quote of a verified page resolves the same way on both paths. */
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
    beats: seam.plan.beats.map((b) => ({ beatId: b.beatId, claim: b.claim, mode: b.mode, kind: b.kind })),
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
    for (const claim of seam.draft.claims) {
      const [source] = sourcesFor([0], [claim], seam.gate.evidence, seam.gate.mode, true);
      if (!source) continue;
      out.push({
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
 */
function gateSeamClaims(seam: SeamState, written: WrittenSeam | undefined, round: number): { script: string; claims: SelectedClaim[]; hints: NarratedBeat["pronunciationHints"] } | string {
  const seamId = seam.plan.seamId;
  const hasBeats = seam.plan.beats.length > 0;
  delete seam.draft;
  delete seam.silent;
  delete seam.confirmed;
  if (!written) {
    if (!hasBeats && seam.intro !== "full") {
      seam.silent = true;
      return "";
    }
    return rejectSeam(seam, [`the writer returned no script for seam ${seamId} — every seam must come back`], [], round);
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
  actScope: { actSourceCount: number; actSourceQuotes: string[] }
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
    charBand: seam.band,
    tapeCitable: true,
    actSourceCount: actScope.actSourceCount,
    actSourceQuotes: actScope.actSourceQuotes
  });
  const issues = structural.issues.map((i) => i.message);
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
    if (seam.intro === "full" && nameable && !introNamesSource(script, clip.brief)) {
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
function judge(toJudge: SeamState[], open: BeatState[], verdicts: ActVerifyResult, actSources: ActSource[], round: number): void {
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
  }

  for (const seam of toJudge) {
    const verdict = verdicts.seams.find((v) => v.seamId === seam.plan.seamId);
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
}

/** The notes for the next round — empty when nothing failed. A seam's
 * own note goes on its SEAM line too (`seamBriefOf`); the act-level
 * list is F-35's running record. */
function roundNotes(seams: SeamState[], beats: Map<string, BeatState>, mechanical: string[]): string[] {
  const notes: string[] = [...mechanical];
  for (const seam of seams) {
    if (!seam.draft || seam.confirmed || seam.frozen) continue;
    if (seam.notes && seam.changed) notes.push(`seam ${seam.plan.seamId}: ${seam.notes}`);
  }
  for (const [beatId, state] of beats) {
    if (state.carried) continue;
    const seam = seams.find((s) => s.plan.seamId === state.seamId)!;
    if (!seam.draft) continue; // its seam was refused in code; that note covers it
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
function assemble(act: SourcedAct, seams: SeamState[], beats: Map<string, BeatState>): WrittenAct {
  const slots: WrittenSlot[] = act.slots.map((slot) => ({
    title: slot.title,
    beats: slot.beats.map((beat): WrittenBeat => {
      if (beat.sourcing === "tape") return { sourcing: "tape", claim: beat.claim, exploration: beat.exploration, tape: beat.tape };
      return { sourcing: "narration", claim: beat.claim, exploration: beat.exploration };
    })
  }));
  const at = (slot: number, beat: number): WrittenBeat => slots[slot]!.beats[beat]!;

  for (const seam of seams) {
    const page = finalPageFor(seam, beats);
    const carrier = seam.plan.beats[0];
    for (const b of seam.plan.beats) {
      const written = at(b.slot, b.beat);
      if (written.sourcing !== "narration") continue;
      const state = beats.get(b.beatId)!;
      if (state.verifiedAtAttempt !== undefined) written.verifiedAtAttempt = state.verifiedAtAttempt;
      if (carrier && b !== carrier) written.carriedBy = { slot: carrier.slot, beat: carrier.beat };
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
function finalPageFor(seam: SeamState, beats: Map<string, BeatState>): NarratedBeat | undefined {
  const hasBeats = seam.plan.beats.length > 0;
  const uncarried = seam.plan.beats.filter((b) => !beats.get(b.beatId)!.carried).map((b) => b.beatId);

  if (seam.confirmed && seam.draft) {
    const { sources, rest, pageIds, notes } = seam.confirmed;
    const verification: SynthesisVerification | undefined = pageIds.length > 0 ? { kind: "synthesis", restsOn: pageIds, attempt: seam.confirmed.round } : undefined;
    const page: NarratedBeat = {
      mode: assignSeamMode(seam.plan, rest),
      script: seam.draft.script,
      sources,
      pronunciationHints: seam.draft.hints,
      verified: uncarried.length === 0,
      purposeAccomplished: uncarried.length === 0,
      ...(verification ? { verification } : {}),
      attempts: seam.attempts
    };
    const evidence = evidenceCarriedBy(seam, page);
    if (uncarried.length === 0) return { ...page, ...(notes ? { verifierNotes: notes } : {}), evidence };
    const note = `beat${uncarried.length > 1 ? "s" : ""} ${uncarried.join(", ")} positioned in this seam ${uncarried.length > 1 ? "are" : "is"} not carried${uncarried.map((id) => beats.get(id)!.notes).filter(Boolean).length > 0 ? ` — ${uncarried.map((id) => beats.get(id)!.notes).filter(Boolean).join("; ")}` : ""}`;
    console.warn(
      `writeAct: keeping seam ${seam.plan.seamId} (${seam.plan.beats.map((b) => b.beatId).join(", ")}) UNVERIFIED after ${seam.attempts.length} attempt(s) — the veracity gate decides (F-51): ${note.slice(0, 200)}`
    );
    return { ...page, verifierNotes: note, evidence };
  }
  if (seam.silent) return undefined;

  const salvage = seam.kept?.page ?? seam.lastPage;
  const notes = (seam.kept?.notes ?? seam.notes ?? seam.attempts[seam.attempts.length - 1]?.rejectionNote ?? "").trim();
  if (salvage) {
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
