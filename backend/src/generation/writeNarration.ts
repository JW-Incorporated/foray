import { decodeEntities } from "../feeds/html";
import type { SourcedAct, SourcedBeat, SourcedSlot, TapePointer } from "../types/tapeSourcing";
import { phraseIsInWindow } from "../types/anchorText";
import {
  containsContestedLanguage,
  disclosureNarratedBeat,
  findHoldingDoc,
  isCompleteSentence,
  MIN_QUOTE_WORDS,
  MODE_CHAR_BANDS,
  modeMayCiteTape,
  quoteEchoesPurpose,
  quoteWords,
  segmentIdOfTapeDoc,
  tapeWindowHolding,
  type EvidenceDoc,
  type NarratedBeat,
  type NarrationMode,
  type Source
} from "../types/narration";
import type { Voice } from "../types/spine";
import type { TranscriptCueProvider } from "./transcriptArchiveLookup";
import { beatKindOf, createEvidenceGatherer, type AdjacentTape, type EvidenceBeat, type EvidenceGatherer, type EvidencePack } from "./gatherEvidence";
import type { GroundPageBrief, NarrationBuildContext, NarrationWriterBuilder, SelectedClaim } from "./NarrationWriterBuilder";
import type { NarrationVerifierBuilder } from "./NarrationVerifierBuilder";
import { writeActNarration } from "./writeAct";

/**
 * §4.7 end to end (docs/curation/generation-architecture.md §4.7): takes
 * §4.5-4.6's `SourcedAct[]` (backend/src/generation/sourceBeats.ts) and,
 * for every narration beat plus any tape beat that needs short connective
 * narration around it, writes a page — grounded in an EVIDENCE PACK
 * gathered first, then checked mechanically, then read by a SEPARATE
 * `NarrationVerifierBuilder`.
 *
 * ONE PATH SINCE F-100. THE ACT IS THE UNIT OF WRITING (Q-03,
 * `writeAct.ts`): the writer is handed the whole act — clips, evidence,
 * beats — and writes continuous prose, one page per SEAM (`actSeams.ts`),
 * with an Intro before each clip (Q-02); the verifier checks each BEAT's
 * claim against that prose and the clips, and a retry edits the act.
 *
 * WHAT THIS MODULE IS NOW. The entry point (`writeNarration`), the act
 * gate that parallelises acts (G-32), the §4.5 decisions a page needs
 * before it is written (`decideConnectiveNarration`, `slotNeighbours`,
 * `adjacentTapeFor`, `evidenceBeatFor`), and THE MECHANICAL RULES both
 * this stage and `writeAct.ts` enforce: the quote gate
 * (`gateSelectedClaims`), the entity decode (`decodeClaimEntities`),
 * attribution read off the held document (`sourcesFor`), and the retry
 * note (`retryNoteFrom`). Those rules were written on the per-page path
 * and every finding below was made there; the act path inherits them
 * unchanged, which is why they live here and not in `writeAct.ts`.
 *
 * THE PER-SLOT PATH IS GONE (F-100, 2026-09-12). Until Q-03 this module
 * also held a per-slot, per-page orchestration — `writeSlot`,
 * `runSlotRound`, `draftRound` and the writer's `selectClaims` /
 * `writePages` / `selectAndWrite` calls behind them. Q-03 superseded it
 * and left it standing as "the fallback for a builder without the act
 * contract", but the only two writer classes and the only two verifier
 * classes either factory can return all implement the contract
 * (`createNarrationWriterBuilder.ts`, `createNarrationVerifierBuilder.ts`),
 * so the fallback could not run in production or in `--dry-run` — only a
 * test that deliberately stripped the contract off a stub reached it. It
 * is deleted rather than kept "just in case": a path no run can take is
 * not a safety net, it is a second definition of the rules that nothing
 * checks. A builder without `writeAct`/`verifyAct` is now an error, not a
 * different route (`writeActNarration` refuses it by name).
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN (WS-A), and the act path keeps it:
 *
 *   evidence  → the documents this act may quote (`gatherEvidence.ts`)
 *   write     → one call per ACT: the prose, seam by seam, with the claims
 *               and the span behind each
 *   CODE      → is that span really in that document? long enough? not the
 *               purpose read back? — decided here, by a substring check
 *   CODE      → structural + copy + negative-claim + empty-source rules,
 *               and every `publication` derived from the held document
 *   verify    → one call per act: the questions a model is actually needed
 *               for, asked per BEAT (carried? by what? resting on what?)
 *
 * A model is never asked to decide something a string comparison can
 * decide, and never gets to be the last check on one. Run 1's writer had
 * every incentive to declare less, shorter, or nothing, because declaring
 * was free and unverifiable; under this order a quote either resolves in a
 * held document or the page does not exist.
 *
 * §4.5's OWN NOTE, RESOLVED HERE: `SourcedBeat` only ever carries
 * `sourcing: "tape"` with a pointer or `sourcing: "narration"` with a
 * Patch/Carry assignment; there is no field for "this tape beat also needs
 * a Hinge/Frame/Marker/Correction around it". `decideConnectiveNarration`
 * below is where that decision is made, deterministically, from beat
 * POSITION within its slot.
 *
 * TWO DISTINCT AGENT ROLES, NEVER COLLAPSED: `writer` and `verifier` must
 * be different builder instances — enforced structurally by
 * `writeNarration` throwing if a caller passes the SAME object reference
 * for both.
 *
 * FAILURE POLICY (F-51): three informed attempts per seam, each retry
 * carrying EVERY prior rejection (F-35). A page that still fails is KEPT,
 * with `verified: false`, its whole `attempts` history and the verifier's
 * final objection in `verifierNotes` — and the run continues.
 *
 * That is a reversal of the policy run 1 shipped with, and the reason is
 * that the thing which used to justify throwing now exists downstream. Run
 * 2 died at act 1 page p2 with ten of twelve pages verified, 34 model calls
 * spent, and a veracity gate (WS-B, `veracityMetrics.ts` ->
 * `cli/publishForay.ts`) sitting unused behind it whose entire job is to
 * judge a flawed candidate and refuse to publish it. Throwing here
 * discards eleven good pages to prevent a twelfth from being published
 * that the gate would have refused anyway. So: a page never kills the
 * Foray, the gate decides. `unverifiedPages` in `meta.veracity` counts
 * these pages and the gate refuses on any of them.
 *
 * RESUME (F-51's second half): `resume` in `WriteNarrationOptions` hands
 * back an already-written slot, so a re-run does not re-pay for an act a
 * previous run finished. Since Q-03 the ACT is what is banked (the
 * driver's `narrate:<i>` stage) and a seam spans slots, so the hook is
 * honoured only when EVERY slot of the act comes back — a half-banked act
 * is written whole.
 */


/** One beat's §4.7 result, preserving its position in the sourced spine.
 * A tape beat carries `connectiveNarration` when a page plays just before
 * it — an Intro (Q-02). A narration beat carries `narration` when it is
 * the first narration beat of its seam, whose page is the seam's whole
 * prose. The seam's other narration beats carry `carriedBy` — the position
 * of the beat holding the page their claim lives in — and no page of their
 * own, so `stitchAct` emits one item per seam. `verifiedAtAttempt` is the
 * round on which the verifier first confirmed the act's prose carries this
 * beat's claim (the beat-level reading `firstAttemptPassRate` is made
 * from). */
export type WrittenBeat =
  | { sourcing: "tape"; claim: string; exploration: boolean; tape: TapePointer; connectiveNarration?: NarratedBeat }
  | {
      sourcing: "narration";
      claim: string;
      exploration: boolean;
      narration?: NarratedBeat;
      carriedBy?: { slot: number; beat: number };
      verifiedAtAttempt?: number;
    };

/** The page a written beat holds, whichever side of the union it is on,
 * or undefined for a beat carried by another beat's page. */
export function pageOfWrittenBeat(beat: WrittenBeat): NarratedBeat | undefined {
  return beat.sourcing === "narration" ? beat.narration : beat.connectiveNarration;
}

export interface WrittenSlot {
  title: string;
  beats: WrittenBeat[];
}
export interface WrittenAct {
  title: string;
  slots: WrittenSlot[];
}

export interface WriteNarrationOptions {
  writer: NarrationWriterBuilder;
  verifier: NarrationVerifierBuilder;
  /** Supplies each beat's evidence pack. Defaults to the real gatherer,
   * which is stub-backed whenever ANTHROPIC_API_KEY is absent — so a
   * dry-run still runs the whole lookup path for real. */
  evidence?: EvidenceGatherer;
  /** The transcript cue provider the DEFAULT gatherer is built with, so a
   * tape beat's evidence pack carries the +/-90 s cue window WS-A specifies
   * and not only the show/episode titles (requirements §8.1). Ignored when
   * `evidence` is supplied — that caller built its own gatherer.
   *
   * This parameter exists because the default was silently wrong: this
   * stage called `createEvidenceGatherer()` with no options, so
   * `DefaultEvidenceGatherer` fell back to `NullTranscriptCueProvider` and
   * every tape page was written without a word of the tape it frames, even
   * on the machine that holds the transcript bodies. §4.5 was threaded the
   * provider (`sourceBeats`); §4.7 was not. */
  cueProvider?: TranscriptCueProvider;
  /** F-51's resume. Returns an already-written slot for
   * `(actIndex, slotIndex)`, or undefined to write it. Deliberately a
   * callback rather than a store object, exactly as `deepenActs` takes one
   * for acts: this stage owns the attempt/failure policy above and keeps
   * owning it; where a written act is kept is the driver's business
   * (`runPipeline.ts` keys it `narrate:<i>`).
   *
   * HONOURED ONLY FOR A FULLY BANKED ACT (Q-03). The act is the unit of
   * writing and a seam spans slots, so an act whose slots come back
   * piecemeal is written whole rather than stitched together out of two
   * runs' prose. */
  resume?: (actIndex: number, slotIndex: number) => WrittenSlot | undefined;
  /** G-34: an accumulator this stage adds to as it runs, for the number
   * the retry tax is paid in. The driver reads it after the stage and
   * reports it in `meta.veracity.retryRounds`; request counts live in the
   * driver's own proxies, which see requests and cannot tell a round.
   * Shared by every act in flight (G-32) — it is a plain counter, and
   * `+= 1` on a single-threaded event loop is not a race. */
  stats?: NarrationWriteStats;
  /** G-32: how many acts may be narrating at once. Defaults to
   * `NARRATION_ACT_CONCURRENCY` (env, default 4 — `narrationActConcurrency`).
   * Every slot of every in-flight act is itself in flight, so this is the
   * lever a rate-limited key throttles with: at 1 the acts run in series,
   * exactly as before G-32. */
  actConcurrency?: number;
  /** Q-02: the segment source rows this run minted (tier 2), so an Intro
   * can be checked against the show and episode title the clip actually
   * comes from when the evidence pack's tape context has no titles. The
   * committed registry is read through the pack (`titlesForItem`); these
   * are the rows not in it yet. */
  segmentSources?: ReadonlyArray<{ id: string; show: string; title: string }>;
  /** F-97: F-88's ground on the act path — the verified pages of the acts
   * that have already landed, read once when an act starts writing. A
   * callback because the driver narrates acts concurrently (G-32) and the
   * set grows while this act is in flight; a thesis seam of a later act
   * may rest on them. Absent (and empty for the acts that start together)
   * means the act rests on its own clips and documents, as before. */
  ground?: () => ReadonlyArray<GroundPageBrief>;
}

/** What `writeNarration` counts that a request proxy cannot (G-34). */
export interface NarrationWriteStats {
  /** Every time a slot went back to the writer after its first round —
   * one per round, whatever the number of pages in it. */
  retryRounds: number;
  /**
   * F-99: beats closed as SEED-LOST (`writeAct.ts`) — seeded from a
   * stretch of tape §4.5 could not place (`SourcedBeat.seedLost`, F-96),
   * and the act's sources could not carry the claim either. Each one is a
   * beat the retry loop deliberately did NOT spend two more rounds on,
   * and a page the gate refuses with `unverifiedReason: "seed-lost"`. The
   * number to watch is the one that says the fix belongs at seeding, not
   * in narration. Optional: only the act path counts them, and a caller
   * that passes no accumulator reports `null` rather than a guessed zero.
   */
  seedLostBeats?: number;
}

/**
 * G-32: the env knob that caps how many acts narrate at once, and its
 * default. Read at CALL time (`narrationActConcurrency`) rather than at
 * import like `config/env.ts`'s budgets, for the same reason
 * `FORAY_SKIP_CATALOGUE_CACHE` is: it is an operator's throttle, not a
 * secret, and a test has to be able to set it without re-importing the
 * module.
 *
 * WHY 4. The latency brief (§3 M1) put ~18 Sonnet + ~30 Haiku calls in
 * flight if a medium Foray's four acts all narrate at once on a key of
 * unknown rate tier, and named 429s as the risk. Four is "every act of a
 * medium Foray", the shape the brief measured; a long Foray (5–7 acts)
 * queues the rest, and an operator who sees 429s in G-20's report turns
 * the number down rather than the feature off.
 */
export const NARRATION_ACT_CONCURRENCY_ENV = "NARRATION_ACT_CONCURRENCY";
export const DEFAULT_NARRATION_ACT_CONCURRENCY = 4;

/**
 * The act-concurrency cap in force: `raw` (defaults to the env var) as a
 * positive integer, or the default when the variable is unset. A variable
 * that is PRESENT but not a positive integer throws, the way
 * `DAILY_BUDGET_USD` does — a typo here silently becoming "4" is precisely
 * the rate-limit surprise the operator was setting it to avoid. The message
 * names the variable, never its value (`env.ts`'s convention).
 */
export function narrationActConcurrency(raw: string | undefined = process.env[NARRATION_ACT_CONCURRENCY_ENV]): number {
  if (raw === undefined) return DEFAULT_NARRATION_ACT_CONCURRENCY;
  const trimmed = raw.trim();
  const n = trimmed.length === 0 ? NaN : Number(trimmed);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`Invalid value for environment variable ${NARRATION_ACT_CONCURRENCY_ENV}: expected a positive integer`);
  }
  return n;
}

/**
 * A FIFO gate that lets at most `limit` tasks run at once — the whole of
 * G-32's throttle, and small enough to read in one sitting rather than a
 * dependency.
 *
 * `run` starts `fn` immediately if a slot is free, otherwise queues it in
 * arrival order. `abort` REJECTS every task still queued (they never start)
 * with the given error, and leaves the in-flight ones alone: work a model
 * is already doing is paid for and its slots are being checkpointed as they
 * land, so the useful thing is to let it finish and bank, not to drop it.
 * Once aborted the gate stays aborted — a task submitted afterwards rejects
 * the same way.
 */
export interface ActGate {
  run<T>(fn: () => Promise<T>): Promise<T>;
  abort(reason: Error): void;
}

export function createActGate(limit: number): ActGate {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new Error(`createActGate: limit must be a positive integer, got ${String(limit)}`);
  }
  let inFlight = 0;
  let aborted: Error | null = null;
  const queue: Array<{ start: () => void; reject: (err: Error) => void }> = [];

  const next = (): void => {
    while (inFlight < limit && queue.length > 0) {
      inFlight++;
      queue.shift()!.start();
    }
  };

  return {
    run<T>(fn: () => Promise<T>): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        if (aborted) {
          reject(aborted);
          return;
        }
        queue.push({
          start: () => {
            fn().then(resolve, reject).finally(() => {
              inFlight--;
              next();
            });
          },
          reject
        });
        next();
      });
    },
    abort(reason: Error): void {
      if (aborted) return;
      aborted = reason;
      /* Rejected NOW, not when a slot frees: a queued act must not outlive
         the failure it is being refused for by however long the in-flight
         acts take to finish. */
      while (queue.length > 0) queue.shift()!.reject(reason);
    }
  };
}

/**
 * narration-craft.md §3b's seam table, reduced to a POSITIONAL rule this
 * stage can apply without stitching context (§4.8 owns the real seam
 * work — silence-vs-bridge, jingles, cross-act continuity). This is
 * deliberately conservative: it only ever proposes a mode for a tape
 * beat that OPENS its slot (S1/S2, "Frame — the common case") or that
 * immediately follows a DIFFERENT-source tape beat within the same slot
 * (S1's cross-episode case, also Frame — a Hinge is for same-episode
 * continuations, which this stage cannot detect from a claim + pointer
 * alone since two segments from the same show are not necessarily the
 * same episode's own continuous recording). A tape beat following
 * another tape beat from the SAME item (episode) gets no connective
 * narration — narration-craft.md §3b S3, "must be marked... where the
 * elision exceeds 5 min", a duration judgement out of this stage's scope
 * (left as a `null` result, i.e. §4.8's silence-is-a-valid-bridge rule
 * applies by default).
 */
export function decideConnectiveNarration(slot: SourcedSlot, beatIndex: number): NarrationMode | null {
  const beat = slot.beats[beatIndex];
  if (!beat || beat.sourcing !== "tape") return null;

  const previous = beatIndex > 0 ? slot.beats[beatIndex - 1] : undefined;

  if (!previous) {
    // Opens the slot: narration-craft.md §3b S1/S2 — a Frame introduces
    // tape that carries the beat and is the common case for entering it.
    return "Frame";
  }

  if (previous.sourcing === "narration") {
    // S4 in narration-craft.md's table (tape -> narration is the OTHER
    // direction; a narration item exiting into tape needs its own
    // Frame-shaped handoff on the tape side, matching S5's "strongest
    // place to use Set-up -> explanation").
    return "Frame";
  }

  // previous.sourcing === "tape"
  if (previous.tape.itemId !== beat.tape.itemId) {
    // Cross-episode tape-to-tape: S1, Frame, attribution mandatory.
    return "Frame";
  }

  // Same-episode continuation: leave to §4.8 (silence or a later
  // duration-aware Hinge decision it is better positioned to make).
  return null;
}

export const NARRATION_PAGE_ATTEMPTS = 3;

/**
 * F-82: the beats on either side of a slot, in play order — the last beat
 * of the slot before it and the first of the slot after it. A page at a
 * slot's edge sits beside them exactly as it sits beside its own slot's
 * beats; slots are an editorial grouping, not a break in the tape.
 */
export interface SlotNeighbours {
  before?: SourcedBeat;
  after?: SourcedBeat;
}

export function slotNeighbours(act: SourcedAct, slotIndex: number): SlotNeighbours {
  const previous = act.slots[slotIndex - 1];
  const following = act.slots[slotIndex + 1];
  return {
    ...(previous && previous.beats.length > 0 ? { before: previous.beats[previous.beats.length - 1] } : {}),
    ...(following && following.beats.length > 0 ? { after: following.beats[0] } : {})
  };
}

/**
 * F-82: THE TAPE ON EITHER SIDE OF A PAGE, in play order.
 *
 * Run 6 (2026-09-11) kept four pages unverified whose claims were the
 * episode's own content — "One host argued that …", "An engineer described
 * buying a small robot …" — because the writer was handed the window of
 * the segment a page INTRODUCES (F-81) and nothing else, so a page that
 * restates the segment that just PLAYED had no citable tape, two web
 * queries found nothing (the claim is the tape's, not the web's), and the
 * page went out as a source-less hand-off the gate refused.
 *
 * So a page in a mode that may cite tape (`TAPE_SOURCE_MODES`) holds the
 * windows of BOTH adjacent segments:
 *
 *   - a connective page on a tape beat plays just BEFORE that beat: its
 *     `next` is the segment it introduces, its `previous` is the beat
 *     before it when that beat is tape;
 *   - a narration beat's page plays AT its beat: `previous` and `next` are
 *     the beats either side when they are tape.
 *
 * A content page (Patch/Carry) is given its neighbours too, so a beat whose
 * claim is what the tape beside it says can be written from that tape
 * (F-82) rather than left with nothing to rest on. Returns undefined when
 * no tape plays beside the page.
 *
 * ONE definition, shared with `evidencePrefetch.ts` through
 * `evidenceBeatFor`, so the prefetch stage gathers the same documents the
 * narration stage asks for and the memo key still hits.
 */
export function adjacentTapeFor(slot: SourcedSlot, beatIndex: number, neighbours: SlotNeighbours = {}): AdjacentTape | undefined {
  const beat = slot.beats[beatIndex];
  if (!beat) return undefined;
  const at = (index: number): SourcedBeat | undefined => {
    if (index < 0) return neighbours.before;
    if (index >= slot.beats.length) return neighbours.after;
    return slot.beats[index];
  };
  const tapeOf = (b: SourcedBeat | undefined): TapePointer | undefined => (b && b.sourcing === "tape" ? b.tape : undefined);

  const previous = tapeOf(at(beatIndex - 1));
  const next = beat.sourcing === "tape" ? beat.tape : tapeOf(at(beatIndex + 1));
  if (!previous && !next) return undefined;
  return { ...(previous ? { previous } : {}), ...(next ? { next } : {}) };
}

/**
 * The `EvidenceBeat` a page's pack is gathered for — the ONE builder both
 * `writeAct.ts` and the prefetch stage's `evidenceBeatsFor` call, so the
 * two cannot ask for different documents (G-35's hit rate depends on the
 * memo key, and the key is made from these fields).
 */
export function evidenceBeatFor(slot: SourcedSlot, beatIndex: number, mode: NarrationMode, neighbours: SlotNeighbours = {}): EvidenceBeat {
  const beat = slot.beats[beatIndex]!;
  const adjacent = adjacentTapeFor(slot, beatIndex, neighbours);
  return {
    claim: beat.claim,
    kind: beatKindOf(beat as unknown as { kind?: unknown }),
    /* F-60: only a page that CARRIES content is worth a second, rephrased
       retrieval query when the first comes back empty. A connective page
       can be written from no documents at all. */
    requiresEvidence: pageCarriesContent(mode),
    ...(beat.sourcing === "tape" ? { tape: beat.tape } : {}),
    ...(adjacent ? { adjacentTape: adjacent } : {})
  };
}

/** Lower-case hyphenated tokens with no spaces — the shape of every
 * `data/segments.json` item id and of a tier-2 minted id. A publication
 * is now derived from a held document's title, so this can only fire if a
 * document itself is named like a slug; kept as a last guard because the
 * cost of it firing wrongly is one retry and the cost of it not existing
 * was a podcast about griddles cited as a source (F-30).
 *
 * Spelled out as three linear tests rather than one regex with a nested
 * quantifier: the obvious `/^[a-z0-9]+(?:[-#][a-z0-9]+){2,}$/` is
 * catastrophically backtrackable on a long non-matching input, and this
 * runs on model output. */
export function looksLikeSlug(text: string): boolean {
  const t = text.trim();
  if (!/^[a-z0-9][a-z0-9#-]*[a-z0-9]$/.test(t)) return false;
  if (/[-#][-#]/.test(t)) return false;
  return (t.match(/[-#]/g) ?? []).length >= 2;
}

export async function writeNarration(acts: SourcedAct[], options: WriteNarrationOptions, voice: Voice, ctx: NarrationBuildContext): Promise<WrittenAct[]> {
  const { writer, verifier } = options;
  if (writer === (verifier as unknown as NarrationWriterBuilder)) {
    throw new Error("writeNarration: writer and verifier must be distinct builder instances (§4.7 rule 2 — verification must never be the writer)");
  }
  const evidence = evidenceGathererFor(options);

  /* G-32: every act is written in parallel, through a gate of
     `actConcurrency`. Nothing in one act's narration depends on another
     act's text:
     the running order and the M3/M4 episode-ordering guarantees were fixed at
     sourcing time, over the whole Foray, before any of this runs. What DOES
     depend on act order — the continuity call at each act boundary and the
     stitched item list — lives in §4.8, and `runPipeline.ts` still drives
     that one act at a time, act N waiting on act N-1. Before G-32 acts 2–4
     of a medium Foray were narrated after act 1 for no reason other than the
     `for` loop that stood here, which is where 6–16 minutes of a keyed run
     went (latency brief §2.3). */
  const gate = createActGate(options.actConcurrency ?? narrationActConcurrency());
  let firstFailure: unknown = null;
  const settled = await Promise.allSettled(
    acts.map((act, actIndex) =>
      gate
        .run(async (): Promise<WrittenAct> => {
          /* Q-03: THE ACT IS THE UNIT OF WRITING. The writer gets the whole
             act's material and writes continuous prose; the verifier checks
             each beat against it; a retry edits the act. `writeActNarration`
             refuses a writer or verifier without the per-act contract by
             name — since F-100 that is the only outcome, not a fork: both
             factories return builders that have it, so a caller without one
             is a test that built a partial builder, and a silent second
             orchestration is a worse answer than an error. Resume is
             honoured only when EVERY slot of the act comes back, because a
             seam spans slots. */
          const banked = act.slots.map((_, slotIndex) => options.resume?.(actIndex, slotIndex));
          if (banked.length > 0 && banked.every((s): s is WrittenSlot => s !== undefined)) return { title: act.title, slots: banked };
          return writeActNarration(
            act,
            { writer, verifier, evidence, stats: options.stats, segmentSources: options.segmentSources, ground: options.ground?.() ?? [] },
            voice,
            ctx
          );
        })
        .catch((err: unknown) => {
          /* The FIRST act to fail is the error this call reports; the acts
             still queued behind it are refused rather than started (their
             rejection is the same error, and is not reported twice), and the
             ones already in flight run to completion so the driver can bank
             every act that lands under its own `narrate:<i>` key.
             `allSettled` rather
             than `all` so this function does not return — and the driver
             does not move on to the next Foray — while narration calls for
             THIS Foray are still landing; `usageTracking` brackets one run
             at a time and that has to stay true. */
          if (firstFailure === null) {
            firstFailure = err;
            gate.abort(err instanceof Error ? err : new Error(String(err)));
          }
          throw err;
        })
    )
  );
  if (firstFailure !== null) throw firstFailure;
  return settled.map((s) => (s as PromiseFulfilledResult<WrittenAct>).value);
}

/**
 * The gatherer a call runs with: the injected one, or a default built WITH
 * the caller's cue provider. Exported because the bug it closes
 * (requirements §8.1) was invisible by construction — `createEvidenceGatherer()`
 * with no arguments is valid, silent, and gives every tape beat a pack
 * with no tape in it — so a test asserts the provider arrives rather than
 * a comment promising it does.
 */
export function evidenceGathererFor(options: WriteNarrationOptions): EvidenceGatherer {
  return options.evidence ?? createEvidenceGatherer(options.cueProvider ? { cueProvider: options.cueProvider } : {});
}

/**
 * THE GATE'S VIEW OF A PAGE: what it is for, and what it may quote. The
 * argument `gateSelectedClaims` and `isTapeClaim` are given, and the shape
 * `writeAct.ts` builds one of per SEAM (`SeamState.gate`).
 *
 * It used to be a mutable per-page record the per-slot orchestration
 * carried through its rounds — the script so far, the rejections, the
 * salvage candidates. F-100 deleted that orchestration, and with it every
 * field only it wrote; what is left is the input the mechanical rules
 * read, which is all this type was ever for from the rules' side.
 */
export interface PendingPage {
  pageId: string;
  beatIndex: number;
  claim: string;
  mode: NarrationMode;
  contextNote?: string;
  evidence: EvidencePack;
  /* Q-03: a seam page written per act may cite any transcript window it
     holds whatever its mode (`ValidateNarratedBeatOptions.tapeCitable`). */
  citesTape?: boolean;
  /* F-97: the page is one seam of an act's prose, and whether a beat's
     claim is carried with support is decided per BEAT by the verifier,
     not per page role at the gate — so §4.7 rule 1's "a Patch must select
     at least one claim" does not fire here. */
  claimsOptional?: boolean;
}


/** A Patch or a Carry IS the beat's content (§4.7 rule 1) — the two modes
 * `validateNarratedBeat` requires a source from, and therefore the two
 * that cannot be written from an empty evidence pack. Every other mode is
 * connective: a hand-off may legitimately assert nothing and cite nothing. */
export function pageCarriesContent(mode: NarrationMode): boolean {
  return mode === "Patch" || mode === "Carry";
}

/**
 * The script a page with nothing to say is allowed to have: one question
 * and one instruction to the listener, and NOT ONE CLAIM ABOUT THE WORLD.
 *
 * That shape is not decorative — it is the only shape
 * `validateNarratedBeat` lets through with zero sources
 * (F-36/F-37/F-44's rule, settled in code so the verifier never has to
 * sample it): every sentence is either a question or opens with a listener
 * imperative, so `hasDeclarativeSentence` finds nothing to demand a source
 * for. A listener hears a beat of narration that hands them onward; what
 * they must never hear is this stage inventing content for a beat whose
 * evidence never arrived.
 */
export const HANDOFF_SCRIPT =
  "Where does this part of the story go next? Keep listening — the thread picks it up on the other side.";

/** Connective, because the page IS a hand-off now: a Hinge's 50-135
 * character band is the one `HANDOFF_SCRIPT` sits inside, and holding the
 * beat's original Carry mode would leave a 100-character page claiming a
 * 765-1870 character budget it has no content to fill. */
export const HANDOFF_MODE: NarrationMode = "Hinge";






/** F-35: every prior rejection, in order. Run 1 overwrote this on each
 * failure, so attempt 3 was told about attempt 2 only and regularly
 * revived the fault attempt 1 was rejected for. */
export function retryNoteFrom(rejections: string[]): string {
  return (
    `${rejections.map((r, i) => `Attempt ${i + 1} was rejected for: ${r}.`).join(" ")} ` +
    "Write a corrected page that fixes every problem listed above — including the earlier ones — while keeping all other rules."
  );
}


/** The evidence pack as the validator sees it: documents, and nothing
 * about how they were found. */
export function heldDocsOf(pack: EvidencePack): EvidenceDoc[] {
  return pack.docs.map((d) => ({ docId: d.docId, title: d.title, ...(d.url ? { url: d.url } : {}), text: d.text }));
}

/**
 * Decodes HTML/XML entities (`&amp;`, `&quot;`, `&#39;`, numeric refs, …)
 * out of the claim-selection call's text fields — reusing
 * `feeds/html.ts`'s `decodeEntities`, already exercised against real feed
 * titles, rather than a second private implementation. Run 1 observed a
 * writer emit `&amp;` in an attribution ("Simon &amp; Schuster"), and a
 * model can put an entity in any prose field it writes (F-26).
 *
 * IT MUST RUN BEFORE THE SUBSTRING CHECK, not after. The held documents
 * are text — a transcript cue window, a retrieved passage — so they carry
 * `&`, not `&amp;`. A quote that arrives entity-encoded is the SAME span
 * of the same document; decoding first is what lets it resolve, and
 * decoding after `validateSelectedClaims` would reject a perfectly good
 * quote for a difference no reader can see.
 *
 * `publication` is not in this list, and that is the WS-A change rather
 * than an omission: it is no longer writer-supplied text at all. It is
 * read off the held document in `sourcesFor`, so an entity could only
 * reach it from a document title, which is upstream of this boundary.
 */
export function decodeClaimEntities(claims: SelectedClaim[]): SelectedClaim[] {
  return claims.map((claim) => ({
    ...claim,
    claimText: decodeEntities(String(claim.claimText ?? "")),
    quote: decodeEntities(String(claim.quote ?? ""))
  }));
}

/**
 * THE MECHANICAL GATE ON THE CLAIM-SELECTION CALL. Every rule here is a
 * substring or a word count; none of them is a judgement, and none of
 * them is ever asked of a model.
 */
export function validateSelectedClaims(claims: SelectedClaim[], page: PendingPage): string[] {
  return gateSelectedClaims(claims, page).issues;
}

/**
 * The same gate, claim by claim: `valid` is every claim that cleared every
 * rule, `issues` names every one that did not. G-34 needs the partition
 * because a merged reply has already written a script by the time the
 * gate runs — the claims that resolved are kept and only that page's
 * prose is re-run — where the split path only ever needed the verdict.
 * The zero-claim rule (§4.7 rule 1) is judged on what SURVIVES, so a
 * content page whose every claim failed is told both things.
 */
export function gateSelectedClaims(claims: SelectedClaim[], page: PendingPage): { valid: SelectedClaim[]; issues: string[] } {
  const issues: string[] = [];
  const valid: SelectedClaim[] = [];
  const docs = heldDocsOf(page.evidence);
  const purposeText = [page.claim, page.contextNote].filter(Boolean).join(" ");

  for (const claim of claims) {
    const where = `claim "${String(claim.claimText ?? "").slice(0, 50)}"`;
    if (!claim.claimText || claim.claimText.trim().length === 0) {
      issues.push("a selected claim has no claim text");
      continue;
    }
    const named = docs.find((d) => d.docId === claim.docId);
    if (!named) {
      issues.push(`${where} cites docId "${claim.docId}", which is not one of the documents provided`);
      continue;
    }
    if (isTapeClaim(claim, page)) {
      /* F-81: THE TAPE IS THE SOURCE. On a page that may cite tape, a
         claim on the transcript window of the segment it introduces
         becomes a tape source (`sourcesFor`), and its holding document is
         the whole window — which the verifier reads — so the rules that
         make a PRINT quote checkable on its own (a verbatim span, eight
         words, not the purpose read back) do not apply. What is checked:
         a quote, if the writer chose to echo one, is spoken in the window
         under the anchor canonicalisation. An empty quote is a page
         describing the segment without echoing it. A Patch or Carry never
         reaches this branch — its beat has no tape, so its pack holds no
         window, and were one handed to it anyway the print rules below
         judge the claim exactly as they always did. */
      const echoed = String(claim.quote ?? "").trim();
      if (echoed && !phraseIsInWindow(echoed, named.text)) {
        /* F-82: a page between two segments holds both windows. A phrase
           the tape did say, cited to the wrong segment's window, is told
           which window says it — the fix is the docId, not the echo. */
        const elsewhere = tapeWindowHolding(echoed, docs, named.docId);
        issues.push(
          elsewhere
            ? `${where}: the quote is not spoken in the transcript window named ("${named.docId}") — it is spoken in the other window this page holds, "${elsewhere.docId}" (the segment ${positionOf(page, elsewhere.docId)}). Cite the segment whose words they are (F-82).`
            : `${where}: the quote is not spoken in the transcript window of the tape beside this page ("${named.title}"). A tape source may echo only the tape's own words — copy a phrase out of that window, or leave the quote empty and describe what the segment says (F-81).`
        );
        continue;
      }
      valid.push(claim);
      continue;
    }
    if (!findHoldingDoc(claim.quote, [named])) {
      const elsewhere = findHoldingDoc(claim.quote, docs);
      issues.push(
        elsewhere
          ? `${where}: the quote is not in "${named.title}" — it is in "${elsewhere.title}". Quote the document you cite.`
          : `${where}: the quote is not a verbatim span of any document provided. Copy a span out of one of them; do not write one from memory (F-14/F-27).`
      );
      continue;
    }
    const words = quoteWords(claim.quote).length;
    if (words < MIN_QUOTE_WORDS && !isCompleteSentence(claim.quote, named.text)) {
      issues.push(`${where}: the quote is ${words} word(s). Take at least ${MIN_QUOTE_WORDS} words, or a whole sentence (F-42).`);
      continue;
    }
    if (quoteEchoesPurpose(claim.quote, purposeText)) {
      issues.push(`${where}: the quote repeats this beat's own purpose or prompt text. The purpose is editorial direction, never a source (F-46).`);
      continue;
    }
    valid.push(claim);
  }

  if (valid.length === 0 && (page.mode === "Patch" || page.mode === "Carry") && page.claimsOptional !== true) {
    issues.push(
      docs.length === 0
        ? `no evidence could be gathered for this ${page.mode} page, and a ${page.mode} page carries the beat's content — it cannot be written unsourced`
        : `a ${page.mode} page carries the beat's content by definition and must select at least one claim from the documents provided (§4.7 rule 1)`
    );
  }
  return { valid, issues };
}

/** F-82: how a held window sits against the page, for a rejection note —
 * "that plays just before this page" / "just after" — or "beside" when
 * the pack was built by a caller that recorded no position. */
function positionOf(page: Pick<PendingPage, "evidence">, docId: string): string {
  const position = page.evidence.docs.find((d) => d.docId === docId)?.tapePosition;
  return position === "previous" ? "that plays just before this page" : position === "next" ? "that plays just after this page" : "beside this page";
}

/**
 * F-81: whether a selected claim is the page citing the tape it
 * introduces — the page's mode may cite tape AND the document named is
 * the transcript window in its pack. The ONE definition the selection
 * gate and `sourcesFor` share, so a claim cannot pass one as tape and
 * leave the other as print.
 */
export function isTapeClaim(claim: SelectedClaim, page: Pick<PendingPage, "mode" | "evidence" | "citesTape">): boolean {
  if (page.citesTape !== true && !modeMayCiteTape(page.mode)) return false;
  return page.evidence.docs.find((d) => d.docId === claim.docId)?.kind === "tape";
}

/**
 * Builds the page's `sources` from the claims the script actually used.
 * ATTRIBUTION IS READ OFF THE DOCUMENT, never written by the page's
 * author: `publication` is the held document's title and `url` its url.
 * That is what makes F-30 (a tape slug as a publication) and F-32 (the
 * same span moving between Wikipedia and Britannica across two attempts)
 * unrepresentable rather than merely forbidden.
 */
export function sourcesFor(usedClaims: number[] | undefined, claims: SelectedClaim[], pack: EvidencePack, mode: NarrationMode, citesTape = false): Source[] {
  const out: Source[] = [];
  const seen = new Set<number>();
  for (const index of usedClaims ?? []) {
    if (!Number.isInteger(index) || index < 0 || index >= claims.length || seen.has(index)) continue;
    seen.add(index);
    const claim = claims[index]!;
    const doc = pack.docs.find((d) => d.docId === claim.docId);
    if (!doc) continue;
    const segmentId = isTapeClaim(claim, { mode, evidence: pack, citesTape }) ? segmentIdOfTapeDoc(doc.docId) : null;
    if (segmentId) {
      /* F-81: a claim on the tape window is a TAPE source — the segment
         named, the quote carried only when the page echoed one, and the
         publication still read off the document (the show and episode). */
      const echoed = String(claim.quote ?? "").trim();
      out.push({
        kind: "tape",
        segmentId,
        claimText: claim.claimText,
        ...(echoed ? { quote: echoed } : {}),
        publication: doc.title,
        contested: claim.contested === true
      });
      continue;
    }
    out.push({
      claimText: claim.claimText,
      quote: claim.quote,
      publication: doc.title,
      ...(doc.url ? { url: doc.url } : {}),
      ...(doc.retrievedAt ? { retrieved: doc.retrievedAt } : {}),
      contested: claim.contested === true
    });
  }
  return out;
}

/** Flattens every `WrittenBeat`'s narration output (the beat's own page
 * plus any connective page a tape beat carries) across `acts` — used by
 * tests and by §4.8's stitching stage, which needs a flat ordered list of
 * narration pages rather than the nested act/slot structure. */
export function allWrittenNarration(acts: WrittenAct[]): NarratedBeat[] {
  const out: NarratedBeat[] = [];
  for (const act of acts) {
    for (const slot of act.slots) {
      for (const beat of slot.beats) {
        const page = pageOfWrittenBeat(beat);
        if (page) out.push(page);
      }
    }
  }
  return out;
}

export { disclosureNarratedBeat, MODE_CHAR_BANDS, containsContestedLanguage };
