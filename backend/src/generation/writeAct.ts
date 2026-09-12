import { BANNED } from "../copy/rules";
import { decodeEntities } from "../feeds/html";
import type { SourcedAct } from "../types/tapeSourcing";
import type { Voice } from "../types/spine";
import {
  tapeDocIdFor,
  validateNarratedBeat,
  type EvidenceDoc as HeldEvidenceDoc,
  type NarratedBeat,
  type NarrationAttemptRecord,
  type NarrationMode,
  type Source
} from "../types/narration";
import type { EvidenceDoc, EvidenceGatherer, EvidencePack } from "./gatherEvidence";
import type {
  ActWriteRequest,
  BeatBrief,
  ClipBrief,
  IntroKind,
  NarrationBuildContext,
  NarrationWriterBuilder,
  SeamBrief,
  SelectedClaim,
  WrittenSeam
} from "./NarrationWriterBuilder";
import type { ActVerifyResult, NarrationVerifierBuilder, VerifyClipBrief, VerifySeamBrief } from "./NarrationVerifierBuilder";
import {
  actBeatsInOrder,
  clipDurationSec,
  clipOpening,
  decideIntro,
  introNamesSource,
  introRestatesClip,
  planActSeams,
  seamBand,
  seamMode,
  type SeamClip,
  type SeamPlan
} from "./actSeams";
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
 * (docs/curation/listening-quality-plan.md; ledger F-95).
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
 * statements against the sources attached to them. A beat the prose does
 * not carry comes back as a NOTE naming it and its claim, and the retry
 * hands the writer the act again — its previous scripts and the notes —
 * to EDIT, not a page to rewrite. Three rounds per act at most.
 *
 * WHAT DID NOT CHANGE. Every mechanical rule the per-page path built up
 * runs on every seam before any verifier sees it: a quote is a span of a
 * held document or the script is spent (`gateSelectedClaims`), attribution
 * is read off the document (`sourcesFor`), the structural validator
 * (`validateNarratedBeat`) with the seam's own band, the slug guard.
 * What counts as verified is F-51's: sources proven in code, judged by a
 * separate verifier. F-88 is untouched. What is NEW in the rules is Q-02:
 * the seam before a clip must name the show or someone the episode title
 * names when the clip needs a full introduction, and must never repeat the
 * clip's first sentences — both checked in code, neither asked of a model.
 *
 * WHERE THE PAGES GO. One page per seam, recorded without changing the
 * item model: on the seam's first narration beat (`WrittenBeat.narration`)
 * — its other narration beats point at it (`carriedBy`) and hold no page —
 * or, for a seam with no beats, as the clip's `connectiveNarration` in
 * mode `Intro`. `stitchAct` walks the beats exactly as before and emits
 * one narration item per seam. The beat list comes out as it went in.
 *
 * FAILURE POLICY, F-51's, at the seam. A seam whose beats the verifier
 * never confirmed keeps its last mechanically clean draft with
 * `verified: false` and the final objection; a seam that never once
 * cleared the mechanical rules keeps the `no-page` hand-off; an intro-only
 * seam that failed is dropped and the clips run together (silence is a
 * valid bridge, §4.8). `unverifiedPages` counts the kept ones and the gate
 * refuses on any — the run never dies over a seam.
 *
 * COST. A clean act is two requests (write, verify). A mechanical
 * rejection re-runs the writer only; a verifier rejection re-runs both.
 * The deck's target — narration calls per act ≤ 3 — is met on the first
 * pass and measured as `narrationCallsPerAct`.
 */

export interface WriteActOptions {
  writer: NarrationWriterBuilder;
  verifier: NarrationVerifierBuilder;
  evidence: EvidenceGatherer;
  stats?: NarrationWriteStats;
  segmentSources?: ReadonlyArray<{ id: string; show: string; title: string }>;
}

interface ClipState {
  plan: SeamClip;
  brief: ClipBrief;
  windowText: string;
}

interface SeamState {
  plan: SeamPlan;
  mode: NarrationMode;
  band: [number, number];
  intro?: IntroKind;
  /** The gate's view of the seam: the act's documents, the beats' claims
   * as the purpose text (F-46), tape citable whatever the mode. */
  gate: PendingPage;
  attempts: NarrationAttemptRecord[];
  /** This round's mechanically clean draft, awaiting the verifier. */
  draft?: { page: NarratedBeat; sources: Source[]; script: string };
  /** The last draft that cleared every mechanical rule — F-51's salvage. */
  kept?: { page: NarratedBeat; notes?: string };
  /** The last page produced at all, mechanically clean or not. */
  lastPage?: NarratedBeat;
  /** The previous round's script, handed back for editing. */
  previousScript?: string;
  /** Set once the verifier accepted the seam and every beat in it. */
  result?: NarratedBeat;
  /** The verifier's last note on this seam. */
  notes?: string;
  /** True for a seam that returned an empty script and may (no beats,
   * intro not full) — no page, silence bridges. */
  silent?: boolean;
}

interface BeatState {
  brief: BeatBrief;
  seamId: string;
  carried: boolean;
  verifiedAtAttempt?: number;
  notes?: string;
}

export async function writeActNarration(act: SourcedAct, options: WriteActOptions, voice: Voice, ctx: NarrationBuildContext): Promise<WrittenAct> {
  const { writer, verifier, evidence, stats } = options;
  if (!writer.writeAct || !verifier.verifyAct) {
    throw new Error("writeActNarration: the writer and verifier must both offer the per-act contract (writeAct / verifyAct)");
  }

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
     cites the one that played first. */
  const documents = actDocuments(beatsInOrder.map(({ slot, beat }) => packs.get(positionKey(slot, beat))!));

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
  const seams: SeamState[] = seamPlans.map((plan) => {
    const mode = seamMode(plan);
    const intro = plan.introduces ? clipById.get(plan.introduces.clipId)!.brief.intro : undefined;
    const purpose = plan.beats.map((b) => b.claim).join(" ");
    return {
      plan,
      mode,
      band: seamBand(plan),
      ...(intro ? { intro } : {}),
      gate: {
        pageId: plan.seamId,
        beatIndex: plan.beats[0]?.beat ?? plan.introduces?.beat ?? 0,
        claim: purpose,
        mode,
        evidence: { purpose, beatKind: "account", docs: documents },
        rejections: [],
        attempts: [],
        citesTape: true
      },
      attempts: []
    };
  });
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
    for (const seam of seams) {
      delete seam.draft;
      delete seam.result;
      delete seam.silent;
    }

    const reply = await writer.writeAct(
      {
        actTitle: act.title,
        voice,
        seams: seams.map(seamBriefOf),
        clips: clips.map((c) => c.brief),
        documents,
        ...(actRejections.length > 0 ? { retryNote: retryNoteFrom(actRejections) } : {})
      },
      ctx
    );

    /* THE MECHANICAL GATE, seam by seam. Every rule a substring or a word
       count can decide, decided here; the verifier is called only for an
       act whose every seam cleared it. */
    const mechanical: string[] = [];
    for (const seam of seams) {
      const issues = draftSeam(seam, reply.seams.find((s) => s.seamId === seam.plan.seamId), clipById, round);
      if (issues.length > 0) mechanical.push(`seam ${seam.plan.seamId}: ${issues.join("; ")}`);
    }
    if (mechanical.length > 0) {
      console.warn(`writeAct: act "${act.title}" round ${round} refused in code — ${mechanical.join(" | ").slice(0, 600)}`);
      actRejections.push(mechanical.join(" | "));
      /* A seam that was clean this round still spent its script: the act
         goes back whole. Recorded so every seam the round took leaves it
         with exactly one attempt, as on the per-page path. */
      const refused = seams.filter((s) => !s.draft && !s.silent).map((s) => s.plan.seamId);
      for (const seam of seams) {
        if (!seam.draft) continue;
        seam.attempts.push({ attempt: round, sources: seam.draft.sources, rejected: true, rejectionNote: `this seam was clean; the act was sent back for seam ${refused.join(", ")}` });
        delete seam.draft;
      }
      continue;
    }

    /* THE VERIFIER, once, for the act: every beat against the prose and
       the clips, every seam's statements against their sources. */
    const verdicts = await verifier.verifyAct(
      {
        actTitle: act.title,
        voice,
        beats: [...beats.values()].map((b) => b.brief),
        seams: seams.filter((s) => s.draft).map(verifySeamBriefOf),
        clips: clips.map((c): VerifyClipBrief => ({ ...c.brief, windowText: c.windowText })),
        documents
      },
      ctx
    );
    const notes = judge(seams, beats, verdicts, round);
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
    mode: seam.mode,
    band: seam.band,
    ...(seam.previousScript !== undefined ? { previousScript: seam.previousScript } : {})
  };
}

function verifySeamBriefOf(seam: SeamState): VerifySeamBrief {
  return {
    seamId: seam.plan.seamId,
    mode: seam.mode,
    script: seam.draft!.script,
    sources: seam.draft!.sources,
    carries: seam.plan.beats.map((b) => b.beatId),
    ...(seam.plan.follows ? { follows: seam.plan.follows.clipId } : {}),
    ...(seam.plan.introduces ? { introduces: seam.plan.introduces.clipId } : {}),
    ...(seam.intro ? { intro: seam.intro } : {})
  };
}

/**
 * One seam's reply through the mechanical gate. Leaves the seam with a
 * `draft` (clean, ready for the verifier), or `silent` (no page here, by
 * the rules), or a recorded rejection; returns the issues. Exactly one
 * attempt is recorded per seam per round, as on the per-page path.
 */
function draftSeam(seam: SeamState, written: WrittenSeam | undefined, clipById: Map<string, ClipState>, round: number): string[] {
  const seamId = seam.plan.seamId;
  const hasBeats = seam.plan.beats.length > 0;
  if (!written) {
    if (!hasBeats && seam.intro !== "full") {
      seam.silent = true;
      return [];
    }
    return rejectSeam(seam, [`the writer returned no script for seam ${seamId} — every seam must come back`], [], round);
  }
  const script = decodeEntities(String(written.script ?? "")).trim();
  seam.previousScript = script;

  if (script.length === 0) {
    if (!hasBeats && seam.intro !== "full") {
      seam.silent = true;
      return [];
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

  const sources = sourcesFor(written.usedClaims, gate.valid, seam.gate.evidence, seam.mode, true);
  const page: NarratedBeat = {
    mode: seam.mode,
    script,
    sources,
    pronunciationHints: written.pronunciationHints ?? [],
    verified: true
  };
  seam.lastPage = page;

  const structural = validateNarratedBeat(page, {
    bannedPhrasePatterns: BANNED,
    heldDocs: heldDocsOf(seam.gate.evidence),
    ...(seam.gate.claim ? { purposeText: seam.gate.claim } : {}),
    charBand: seam.band,
    tapeCitable: true
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

  if (issues.length > 0) return rejectSeam(seam, issues, sources, round);

  seam.kept = { page };
  seam.draft = { page, sources, script };
  return [];
}

function rejectSeam(seam: SeamState, issues: string[], sources: Source[], round: number): string[] {
  const note = issues.join("; ");
  seam.attempts.push({ attempt: round, sources, rejected: true, rejectionNote: note });
  return issues;
}

/**
 * The verifier's answer applied: each beat's `carried` and the round it
 * was first confirmed on; each seam's result. Returns the notes for the
 * next round — empty when the act passed whole.
 */
function judge(seams: SeamState[], beats: Map<string, BeatState>, verdicts: ActVerifyResult, round: number): string[] {
  const notes: string[] = [];
  for (const [beatId, state] of beats) {
    const verdict = verdicts.beats.find((v) => v.beatId === beatId);
    const carried = verdict?.carried === true;
    state.carried = carried;
    if (carried) {
      if (state.verifiedAtAttempt === undefined) state.verifiedAtAttempt = round;
      delete state.notes;
      continue;
    }
    /* Dropped by a later round's edit: the confirmation no longer stands. */
    delete state.verifiedAtAttempt;
    state.notes = verdict ? (verdict.notes ?? "") : "the verifier returned no verdict for this beat";
    notes.push(
      verdict
        ? `the prose does not carry beat ${beatId} (${state.brief.claim.slice(0, 120)})${verdict.notes ? ` — ${verdict.notes}` : ""}; add it where it belongs (seam ${state.seamId})`
        : `the verifier returned no verdict for beat ${beatId} (${state.brief.claim.slice(0, 120)})`
    );
  }

  for (const seam of seams) {
    if (!seam.draft) continue;
    const verdict = verdicts.seams.find((v) => v.seamId === seam.plan.seamId);
    const failures: string[] = [];
    if (!verdict) failures.push("the verifier returned no verdict for this seam");
    else {
      if (!verdict.claimsSupported) failures.push("a statement in the script is not supported by the source attached to it");
      if (!verdict.contestedHandled) failures.push("a genuinely contested point is not handled as §4.7 rule 3 requires");
    }
    const uncarried = seam.plan.beats.filter((b) => !beats.get(b.beatId)!.carried).map((b) => b.beatId);
    const seamNote = verdict?.notes;
    if (failures.length > 0) {
      const note = `${failures.join("; ")}${seamNote ? ` — ${seamNote}` : ""}`;
      seam.notes = note;
      seam.kept = { page: seam.draft.page, notes: note };
      seam.attempts.push({ attempt: round, sources: seam.draft.sources, rejected: true, rejectionNote: note });
      notes.push(`seam ${seam.plan.seamId}: ${note}`);
      continue;
    }
    if (uncarried.length > 0) {
      const note = `beat${uncarried.length > 1 ? "s" : ""} ${uncarried.join(", ")} positioned in this seam ${uncarried.length > 1 ? "are" : "is"} not carried`;
      seam.notes = note;
      seam.kept = { page: seam.draft.page, notes: note };
      seam.attempts.push({ attempt: round, sources: seam.draft.sources, rejected: true, rejectionNote: note });
      continue;
    }
    seam.attempts.push({ attempt: round, sources: seam.draft.sources, rejected: false });
    delete seam.notes;
    seam.result = {
      ...seam.draft.page,
      purposeAccomplished: true,
      ...(seamNote ? { verifierNotes: seamNote } : {})
    };
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
    const page = finalPageFor(seam);
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

/** The page a seam leaves behind: its verified result; else (F-51) the
 * last mechanically clean draft, unverified, with the final objection;
 * else the last page produced at all; else, for a seam with beats, the
 * `no-page` hand-off; and nothing for a silent or a failed intro-only
 * seam. The evidence carried is the documents the page cites plus the
 * windows of the clips on either side, so `groundedQuoteRate` resolves
 * every quote and the report's restate check has the clip's opening. */
function finalPageFor(seam: SeamState): NarratedBeat | undefined {
  const evidence = evidenceCarriedBy(seam);
  if (seam.result) return { ...seam.result, evidence, attempts: seam.attempts };
  if (seam.silent) return undefined;

  const hasBeats = seam.plan.beats.length > 0;
  const salvage = seam.kept?.page ?? seam.lastPage;
  const notes = (seam.kept?.notes ?? seam.notes ?? seam.attempts[seam.attempts.length - 1]?.rejectionNote ?? "").trim();
  if (salvage) {
    if (!hasBeats) {
      console.warn(
        `writeAct: dropping the introduction before clip ${seam.plan.introduces?.clipId ?? "?"} (act "${seam.plan.seamId}") after ${seam.attempts.length} rejected attempt(s) — clips run together, silence bridges (${notes.slice(0, 200)})`
      );
      return undefined;
    }
    console.warn(
      `writeAct: keeping seam ${seam.plan.seamId} (${seam.plan.beats.map((b) => b.beatId).join(", ")}) UNVERIFIED after ${seam.attempts.length} attempt(s) — the veracity gate decides (F-51): ${notes.slice(0, 200)}`
    );
    return {
      ...salvage,
      verified: false,
      purposeAccomplished: false,
      ...(notes ? { verifierNotes: notes } : {}),
      evidence,
      attempts: seam.attempts
    };
  }
  if (!hasBeats) return undefined;
  console.warn(
    `writeAct: no page was ever produced for seam ${seam.plan.seamId} (${seam.plan.beats.map((b) => b.beatId).join(", ")}) — keeping an unverified hand-off in its place (F-51/F-60): ${notes.slice(0, 200)}`
  );
  return {
    mode: HANDOFF_MODE,
    script: HANDOFF_SCRIPT,
    sources: [],
    pronunciationHints: [],
    verified: false,
    unverifiedReason: "no-page",
    verifierNotes: notes || "no page was produced",
    evidence,
    attempts: seam.attempts
  };
}

function evidenceCarriedBy(seam: SeamState): HeldEvidenceDoc[] {
  const page = seam.result ?? seam.kept?.page ?? seam.lastPage;
  const cited = new Set<string>();
  for (const source of page?.sources ?? []) {
    const doc = seam.gate.evidence.docs.find((d) => d.title === source.publication || ("url" in source && source.url !== undefined && d.url === source.url));
    if (doc) cited.add(doc.docId);
    if ("segmentId" in source) cited.add(tapeDocIdFor(source.segmentId));
  }
  if (seam.plan.follows) cited.add(tapeDocIdFor(seam.plan.follows.tape.segmentId));
  if (seam.plan.introduces) cited.add(tapeDocIdFor(seam.plan.introduces.tape.segmentId));
  return heldDocsOf({ ...seam.gate.evidence, docs: seam.gate.evidence.docs.filter((d) => cited.has(d.docId)) });
}
