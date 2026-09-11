import { BANNED } from "../copy/rules";
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
  tapeDocIdFor,
  tapeWindowHolding,
  validateNarratedBeat,
  type EvidenceDoc,
  type NarratedBeat,
  type NarrationAttemptRecord,
  type NarrationMode,
  type Source,
  type UnverifiedReason
} from "../types/narration";
import type { Voice } from "../types/spine";
import type { TranscriptCueProvider } from "./transcriptArchiveLookup";
import {
  beatKindOf,
  createEvidenceGatherer,
  emptyEvidencePack,
  type AdjacentTape,
  type EvidenceBeat,
  type EvidenceDoc as GatheredDoc,
  type EvidenceGatherer,
  type EvidencePack
} from "./gatherEvidence";
import type {
  NarrationBuildContext,
  NarrationPageBrief,
  NarrationWriterBuilder,
  ProsePageBrief,
  SelectedClaim,
  WrittenPage
} from "./NarrationWriterBuilder";
import type { NarrationVerifierBuilder, PageVerdict, VerifyPageBrief } from "./NarrationVerifierBuilder";

/**
 * §4.7 end to end (docs/curation/generation-architecture.md §4.7): takes
 * §4.5-4.6's `SourcedAct[]` (backend/src/generation/sourceBeats.ts) and,
 * for every narration beat plus any tape beat that needs short
 * connective narration around it, writes a page — grounded in an
 * EVIDENCE PACK gathered first, then checked mechanically, then read by a
 * SEPARATE `NarrationVerifierBuilder`.
 *
 * THE ORDER OF OPERATIONS IS THE DESIGN (WS-A):
 *
 *   evidence  → the documents this page may quote (`gatherEvidence.ts`)
 *   select    → one call per slot: which claims, and the span behind each
 *   CODE      → is that span really in that document? long enough? not the
 *               purpose read back? — decided here, by a substring check
 *   prose     → one call per slot: the scripts, from those claims only
 *   CODE      → structural + copy + negative-claim + empty-source rules,
 *               and every `publication` derived from the held document
 *   verify    → one call per slot: three questions a model is actually
 *               needed for (support, purpose, contested)
 *
 * A model is never asked to decide something a string comparison can
 * decide, and never gets to be the last check on one. Run 1's writer had
 * every incentive to declare less, shorter, or nothing, because declaring
 * was free and unverifiable; under this order a quote either resolves in a
 * held document or the page does not exist.
 *
 * THE RETRY TAX, CUT (G-34, latency model M3 levers a and b). Two things
 * changed in how the order above is PAID for, and neither changes what it
 * checks:
 *
 *   - select and prose are ONE call when the builder offers
 *     `selectAndWrite` (the real and stub builders both do). The quote
 *     gate runs on the combined reply exactly as it ran between the two
 *     replies; a page whose quotes all resolve keeps its script, and a
 *     page with a quote that does not has spent that script — the claims
 *     that DID resolve are kept and only that page's prose is re-run.
 *   - a rejection after the gate (a structural rule, or the verifier)
 *     re-runs prose + verify for the rejected PAGES only. Pages that
 *     passed keep their scripts, and the rejected page's claims are not
 *     re-selected: they already passed the substring gate, and re-asking
 *     for them was the whole slot's select → prose → verify a second
 *     time, three calls where two are enough. A page that holds NO
 *     grounded claim re-selects, because there is nothing to write prose
 *     from and a merged call costs what a prose call costs.
 *
 * What is NOT changed: three attempts per page, the F-51 outcomes below,
 * and every mechanical rule. Lever (c) of M3 — treating a `purposeRevised`
 * page's `purposeAccomplished: false` as accepted — is a founder call and
 * is not built here.
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
 * FAILURE POLICY (F-51): three informed attempts per page, each retry
 * carrying EVERY prior rejection (F-35). A connective page that still
 * fails is dropped and its tape kept (§4.8's silence-is-a-valid-bridge
 * rule covers the seam). A NARRATION page that still fails is KEPT, with
 * `verified: false`, its whole `attempts` history and the verifier's final
 * objection in `verifierNotes` — and the run continues.
 *
 * That is a reversal of the previous policy, and the reason is that the
 * thing which used to justify throwing now exists downstream. Run 2 died
 * at act 1 page p2 with ten of twelve pages verified, 34 model calls
 * spent, and a veracity gate (WS-B, `veracityMetrics.ts` ->
 * `cli/publishForay.ts`) sitting unused behind it whose entire job is to
 * judge a flawed candidate and refuse to publish it. Throwing here
 * discards eleven good pages to prevent a twelfth from being published
 * that the gate would have refused anyway. So: a page never kills the
 * Foray, the gate decides. `unverifiedPages` in `meta.veracity` counts
 * these pages and the gate refuses on any of them.
 *
 * NO EVIDENCE IS NOT A FAILURE EITHER (F-60). Run 2's act 1 p5 asked for
 * evidence, got `{"passages": []}`, and then spent THREE claim-selection
 * calls on a prompt whose own text said "Documents: none were retrieved
 * for this page" — each one rejected by a mechanical rule ("a Carry page
 * cannot be written unsourced") before any model could have helped, each
 * retry note telling the writer to fix a rejection it had no way to fix,
 * and the third leaving no page at all, which was fatal. Both halves are
 * closed: `gatherEvidence` asks a second, rephrased query before giving
 * up, and a content page whose pack is STILL empty never reaches the
 * writer at all. It becomes an unverified hand-off — a question and a
 * bridge, asserting nothing, `unverifiedReason: "no-evidence"` — counted
 * by `unverifiedPages` and refused by the same gate.
 *
 * The beat KEEPS ITS PAGE rather than losing it the way a connective page
 * is dropped, and that is forced rather than chosen: a connective page's
 * beat survives as its tape, while a narration beat IS its page, so
 * dropping one would drop a beat — and §4.5's guarantee that the beat list
 * comes out of the pipeline exactly as it went in (`validateSourcing`,
 * and `stitchAct`/`computePagesDropped`, which index written beats
 * positionally against sourced ones) would break.
 *
 * `NarrationWriteError` therefore no longer fires for any page. It
 * survives as the guard on the one thing left that this stage cannot
 * honestly return — a slot that came out with fewer beats than it went in
 * with — which is unreachable by construction and pinned as unreachable by
 * a test.
 *
 * PER-SLOT CHECKPOINT (F-51's second half): `resume`/`onSlotWritten` in
 * `WriteNarrationOptions` are the same pair of callbacks `deepenActs` has
 * for acts, at slot granularity — the driver keys them `narrate:<act>:<slot>`
 * so a re-run pays only for the slots not yet written. Run 2's re-run
 * would have re-paid for all twelve of act 1's pages to reach the one
 * that failed.
 */

/**
 * A slot that lost beats — the one unrecoverable outcome left in §4.7.
 *
 * It used to mean "this page could not be written", and that is precisely
 * what it must no longer mean: a page that cannot be written is kept
 * unverified (F-51) or, when there was nothing to write it from, degraded
 * to a hand-off (F-60), and the veracity gate decides. Nothing in the
 * per-page path throws.
 */
export class NarrationWriteError extends Error {
  constructor(
    public readonly claim: string,
    public readonly mode: NarrationMode,
    public readonly cause: unknown
  ) {
    super(`Writing narration for "${claim}" (mode ${mode}) failed after ${NARRATION_PAGE_ATTEMPTS} attempts: ${(cause as Error)?.message ?? String(cause)}`);
    this.name = "NarrationWriteError";
  }
}

/**
 * One page's validation failure, with every rejection that produced it.
 *
 * Kept, and no longer thrown by this module: F-51 turned a page's third
 * rejection into an unverified page and F-60 turned an unwritable one into
 * a hand-off, so there is no path left that ends a run over a page. It
 * remains the typed shape of "this page did not validate, and here is
 * every reason" — the record `foray-generation-requirements.md` §8's
 * failure table still describes, and the type an editor tool would build
 * from `NarratedBeat.attempts`.
 */
export class InvalidNarratedBeatError extends Error {
  constructor(
    public readonly claim: string,
    public readonly mode: NarrationMode,
    public readonly issues: string[]
  ) {
    super(`Narration for "${claim}" (mode ${mode}) failed validation: ${issues.join("; ")}`);
    this.name = "InvalidNarratedBeatError";
  }
}

/** One beat's §4.7 result, preserving its position in the sourced spine.
 * A tape beat carries `connectiveNarration` only when
 * `decideConnectiveNarration` decided one was needed; a narration beat
 * always carries `narration`. */
export type WrittenBeat =
  | { sourcing: "tape"; claim: string; exploration: boolean; tape: TapePointer; connectiveNarration?: NarratedBeat }
  | { sourcing: "narration"; claim: string; exploration: boolean; narration: NarratedBeat };

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
  /** F-51's per-slot resume. Returns an already-written slot for
   * `(actIndex, slotIndex)`, or undefined to write it. Deliberately a
   * callback pair rather than a store object, exactly as `deepenActs`
   * takes one for acts: this stage owns the attempt/failure policy above
   * and keeps owning it; where a written slot is kept is the driver's
   * business (`runPipeline.ts` keys it `narrate:<act>:<slot>`). */
  resume?: (actIndex: number, slotIndex: number) => WrittenSlot | undefined;
  /** Called with each slot the moment it is written — never for a resumed
   * one, which is already stored. Awaited BEFORE the act's `Promise.all`
   * settles, so a slot that finished is banked even when a sibling slot
   * throws, which is the whole point of the key. */
  onSlotWritten?: (actIndex: number, slotIndex: number, slot: WrittenSlot) => void | Promise<void>;
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
}

/** What `writeNarration` counts that a request proxy cannot (G-34). */
export interface NarrationWriteStats {
  /** Every time a slot went back to the writer after its first round —
   * one per round, whatever the number of pages in it. */
  retryRounds: number;
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
 * A content page (Patch/Carry) is given its neighbours too — not to cite
 * as tape (F-81's mode rule stands) but so that `writeSlot` can see, when
 * no print was found for it, that the tape beside it is what the claim is
 * about and write it as a Hinge from that tape instead of degrading it to
 * a placeholder. Returns undefined when no tape plays beside the page.
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
 * `writeSlot` and the prefetch stage's `evidenceBeatsFor` call, so the two
 * cannot ask for different documents (G-35's hit rate depends on the memo
 * key, and the key is made from these fields).
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

  /* G-32: every act is written in parallel too, through a gate of
     `actConcurrency`. Nothing in one act's narration depends on another
     act's text, for the same reason nothing in one SLOT does (WS-D1, below):
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
          /* WS-D1: every slot in an act is written in parallel. Nothing in
             a slot depends on another slot's text (see above), so the only
             thing serialising them bought was wall time, and narration is
             the largest stage. */
          const slots = await Promise.all(
            act.slots.map(async (slot, slotIndex) => {
              const resumed = options.resume?.(actIndex, slotIndex);
              if (resumed) return resumed;
              const written = await writeSlot(slot, writer, verifier, evidence, voice, ctx, options.stats, slotNeighbours(act, slotIndex));
              await options.onSlotWritten?.(actIndex, slotIndex, written);
              return written;
            })
          );
          return { title: act.title, slots };
        })
        .catch((err: unknown) => {
          /* The FIRST act to fail is the error this call reports; the acts
             still queued behind it are refused rather than started (their
             rejection is the same error, and is not reported twice), and the
             ones already in flight run to completion so every slot they
             finish is banked through `onSlotWritten`. `allSettled` rather
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

/** A page in flight: what it is for, what it may quote, what has been
 * said about it so far, and its result once it has one. Exported for
 * F-88's synthesis pass (`synthesisVerify.ts`), which drafts a page
 * through exactly this shape and `draftRound` below. */
export interface PendingPage {
  pageId: string;
  beatIndex: number;
  claim: string;
  mode: NarrationMode;
  contextNote?: string;
  evidence: EvidencePack;
  rejections: string[];
  attempts: NarrationAttemptRecord[];
  result?: NarratedBeat;
  /* G-34: the grounded claims this page carries into its next round,
     when the round it just had was rejected AFTER the quote gate (or
     only partly at it). Set means "re-run prose only, from these";
     unset means "select again". Never set to an empty list: a page with
     nothing to write from re-selects. */
  claims?: SelectedClaim[];
  /* F-51's two salvage slots. `kept` is the most recent page that cleared
     every MECHANICAL rule and was rejected only by the verifier — the page
     an editor can actually work with, and the one preferred when the third
     attempt is spent. `lastBeat` is the most recent page produced at all,
     including one the structural validator refused, kept only so a beat
     that never once cleared the mechanical rules still leaves something
     behind rather than ending the Foray. */
  kept?: { beat: NarratedBeat; verdict?: PageVerdict };
  lastBeat?: NarratedBeat;
}

async function writeSlot(
  slot: SourcedSlot,
  writer: NarrationWriterBuilder,
  verifier: NarrationVerifierBuilder,
  evidence: EvidenceGatherer,
  voice: Voice,
  ctx: NarrationBuildContext,
  stats?: NarrationWriteStats,
  neighbours: SlotNeighbours = {}
): Promise<WrittenSlot> {
  const pages: PendingPage[] = [];
  for (let i = 0; i < slot.beats.length; i++) {
    const beat = slot.beats[i]!;
    if (beat.sourcing === "narration") {
      pages.push(newPage(`p${i}`, i, beat.claim, beat.narration.mode));
      continue;
    }
    const connectiveMode = decideConnectiveNarration(slot, i);
    if (!connectiveMode) continue;
    const previous = adjacentTapeFor(slot, i, neighbours)?.previous;
    pages.push(
      newPage(
        `p${i}`,
        i,
        beat.claim,
        connectiveMode,
        /* F-81: the page may describe the tape it introduces — what the
           segment is about, who is speaking — citing the tape itself as
           its source (the transcript window in its evidence pack). What it
           still may not do is give the tape's answer away. F-82: when tape
           plays just before it, that window is held too, and anything the
           page says about what THAT tape said is cited to it. */
        `This page hands the listener into or out of real tape — ${tapeDescription(beat)}. It may say what that tape is about and who is speaking, citing the tape itself as its source (document ${tapeDocIdFor(beat.tape.segmentId)}); it does not give away the answer the tape gives (narration-craft.md's spoiler rule).` +
          (previous
            ? ` The tape that plays just before this page (document ${tapeDocIdFor(previous.segmentId)}) is held too: anything this page says about what that tape said must cite that window, never an outside publication (F-82).`
            : "")
      )
    );
  }

  await Promise.all(
    pages.map(async (page) => {
      page.evidence = await evidence.gather(evidenceBeatFor(slot, page.beatIndex, page.mode, neighbours), ctx);
    })
  );

  /* F-60, THE GUARD THAT SPENDS NOTHING. A Patch/Carry page whose pack is
     empty after `gatherEvidence`'s two queries cannot be written by any
     model: `validateSelectedClaims` will reject whatever comes back, in
     code, before the prose call — which is exactly what run 2 paid three
     selection calls to discover. Marking the page here takes it out of
     `pending`, so a slot whose every page is in this state makes ZERO
     writer calls.

     F-82, THE CASE F-60 WAS DEGRADING FOR THE WRONG REASON. Run 6's four
     unverified pages were content beats whose claims were what the tape
     beside them says — the deepen stage wrote the claim from the episode,
     sourcing placed the episode's segment next door, and the web had
     nothing to say because the transcript this pipeline holds is the only
     text that says it. Those pages are not evidence-less; their evidence
     is the tape. When no print was found but a neighbouring window is
     held, the page is written as a HINGE from that tape — the mode the
     hand-off already took (`HANDOFF_MODE`), now with a script that
     restates or attributes what the tape said and cites it — and only a
     page with neither print nor tape is still degraded unwritten. */
  for (const page of pages) {
    if (!pageCarriesContent(page.mode)) continue;
    if (page.evidence.docs.some((doc) => doc.kind !== "tape")) continue;
    const windows = page.evidence.docs.filter((doc) => doc.kind === "tape");
    if (windows.length > 0) {
      console.log(
        `writeNarration: no print for the ${page.mode} page "${page.claim.slice(0, 80)}" (slot "${slot.title}"), but the tape beside it is held — ` +
          `writing it as a ${HANDOFF_MODE} that cites that tape (F-82)`
      );
      page.mode = HANDOFF_MODE;
      page.contextNote = hingeFromTapeNote(windows);
      continue;
    }
    console.warn(
      `writeNarration: no evidence for the ${page.mode} page "${page.claim.slice(0, 80)}" (slot "${slot.title}") after two retrieval queries — ` +
        "degrading it to an unverified hand-off without calling the writer; the veracity gate refuses to publish over it (F-60)"
    );
    page.result = handOffPage("no-evidence", NO_EVIDENCE_NOTE, [], heldDocsOf(page.evidence));
  }

  /* Rounds, not slot attempts (G-34). Every page still gets at most
     `NARRATION_PAGE_ATTEMPTS` attempts — a round records exactly one
     attempt (a rejection or a result) on every page it takes, so the
     per-page filter is the rule and the loop bound is only its guard.
     What a round DOES for a page depends on what the page already holds:
     see `runSlotRound`. */
  for (let round = 0; round < NARRATION_PAGE_ATTEMPTS; round++) {
    const pending = pages.filter((p) => !p.result && p.attempts.length < NARRATION_PAGE_ATTEMPTS);
    if (pending.length === 0) break;
    if (round > 0 && stats) stats.retryRounds += 1;
    await runSlotRound(slot.title, pending, writer, verifier, voice, ctx);
  }

  const beats: WrittenBeat[] = [];
  for (let i = 0; i < slot.beats.length; i++) {
    const beat = slot.beats[i]!;
    const page = pages.find((p) => p.beatIndex === i);

    if (beat.sourcing === "narration") {
      /* F-51. A narration page is the beat's content, so it cannot be
         dropped the way a connective page can — but it no longer takes the
         Foray down either. The last attempt is kept unverified and the
         run continues; `meta.veracity.unverifiedPages` counts it and
         `evaluateVeracityGate` refuses to publish over it. */
      const result =
        page?.result ?? (page ? unverifiedResultFor(page, slot.title) : undefined) ?? noPageFor(page, slot.title, beat.claim);
      beats.push({ sourcing: "narration", claim: beat.claim, exploration: beat.exploration, narration: result });
      continue;
    }

    if (page && !page.result) {
      /* A CONNECTIVE PAGE THAT CANNOT BE WRITTEN DOES NOT TAKE THE FORAY
         DOWN. The beat's content is the tape; the Frame around it is a
         courtesy §4.8's silence-is-a-valid-bridge rule already covers when
         no page exists. Run 1 attempt 3 died at beat 5 of 31 because a
         connective page failed verification twice — thirty beats of
         finished work discarded for one hand-off line. */
      console.warn(
        `writeNarration: dropping the ${page.mode} page for tape beat "${beat.claim.slice(0, 80)}" after ${NARRATION_PAGE_ATTEMPTS} rejected attempts — tape kept, silence bridges (${page.rejections.join(" | ").slice(0, 200)})`
      );
    }
    beats.push({
      sourcing: "tape",
      claim: beat.claim,
      exploration: beat.exploration,
      tape: beat.tape,
      ...(page?.result ? { connectiveNarration: page.result } : {})
    });
  }

  /* THE LAST PLACE `NarrationWriteError` CAN FIRE — and it cannot. Every
     narration beat above leaves a page behind (verified, unverified, or a
     degraded hand-off) and every tape beat leaves its tape, so `beats` is
     built one entry per input beat with no branch that skips one. The
     check stays because the invariant is worth more than the branch costs:
     if a future edit ever does drop a beat, §4.5's beat list would silently
     stop matching §4.7's output and every positional consumer downstream
     (`stitchAct`'s coverage, `computePagesDropped`) would quietly
     misattribute pages to beats. `writeNarration.test.ts` pins this as
     unreachable rather than as behaviour. */
  if (beats.length !== slot.beats.length) {
    const first = slot.beats[0]!;
    throw new NarrationWriteError(
      first.claim,
      first.sourcing === "narration" ? first.narration.mode : "Frame",
      new Error(
        `slot "${slot.title}" came out with ${beats.length} of ${slot.beats.length} beats — §4.5's beat list must survive §4.7 unchanged`
      )
    );
  }

  return { title: slot.title, beats };
}

/** A Patch or a Carry IS the beat's content (§4.7 rule 1) — the two modes
 * `validateNarratedBeat` requires a source from, and therefore the two
 * that cannot be written from an empty evidence pack. Every other mode is
 * connective: a hand-off may legitimately assert nothing and cite nothing. */
export function pageCarriesContent(mode: NarrationMode): boolean {
  return mode === "Patch" || mode === "Carry";
}

/** What `verifierNotes` says on a page no verifier ever saw (F-60). */
export const NO_EVIDENCE_NOTE = "no evidence retrieved after two queries";

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

/** A page that holds its beat's place without asserting anything —
 * `verified: false` and a reason, so `unverifiedPages` counts it, the
 * gate refuses it, and an editor can see at a glance whether there is a
 * draft to fix (`no-page`) or a beat with no evidence behind it at all
 * (`no-evidence`). */
function handOffPage(
  reason: UnverifiedReason,
  notes: string,
  attempts: NarrationAttemptRecord[],
  evidence: EvidenceDoc[]
): NarratedBeat {
  return {
    mode: HANDOFF_MODE,
    script: HANDOFF_SCRIPT,
    sources: [],
    pronunciationHints: [],
    verified: false,
    unverifiedReason: reason,
    verifierNotes: notes,
    evidence,
    attempts
  };
}

/**
 * The narration beat that produced no page at all: evidence existed, but
 * no attempt ever cleared the mechanical rules far enough to reach the
 * prose call, so there is no draft to keep unverified (F-51's salvage
 * returned nothing).
 *
 * This used to be `NarrationWriteError`, i.e. the end of the Foray. It is
 * now the same hand-off an evidence-less page gets, carrying `no-page` and
 * the last rejection — because the gate refusing to publish a Foray with
 * one placeholder page in it is strictly better than discarding every
 * other page in the run to prevent that page from existing.
 */
function noPageFor(page: PendingPage | undefined, slotTitle: string, claim: string): NarratedBeat {
  const notes = (page?.rejections[page.rejections.length - 1] ?? "no page was produced").trim();
  console.warn(
    `writeNarration: no page was ever produced for "${claim.slice(0, 80)}" (slot "${slotTitle}") — ` +
      `keeping an unverified hand-off in its place so the rest of the Foray survives (F-51/F-60): ${notes.slice(0, 200)}`
  );
  return handOffPage("no-page", notes, page?.attempts ?? [], page ? heldDocsOf(page.evidence) : []);
}

/** A page's script for this round, with the grounded claims it was
 * written from — whichever call produced it. */
interface Draft {
  page: PendingPage;
  claims: SelectedClaim[];
  written: WrittenPage;
}

/**
 * One round over the slot's still-pending pages (G-34). A page arrives
 * in one of two states and the round spends accordingly:
 *
 *   - NO grounded claims yet (its first round, or its last round failed
 *     at the quote gate outright): it joins the SELECTION batch. That is
 *     one merged select+prose call when the builder offers one — the
 *     quote gate then runs on the reply, and a page whose quotes all
 *     resolve is written — or the two-call pair when it does not.
 *   - grounded claims from an earlier round (rejected after the gate,
 *     or only partly at it): it joins the PROSE batch. One `writePages`
 *     call for those pages only, from those claims only. Nothing is
 *     re-selected — those quotes were proven once and are still proven.
 *
 * Both batches then go through the same structural gate and the same
 * ONE verifier call. So a round is at most three requests (merged,
 * prose, verify), a first round is two, and a retry round is two —
 * where each used to be three for the whole slot.
 *
 * Every page the round takes leaves it with exactly one attempt
 * recorded: a rejection or a result.
 */
async function runSlotRound(
  slotTitle: string,
  pending: PendingPage[],
  writer: NarrationWriterBuilder,
  verifier: NarrationVerifierBuilder,
  voice: Voice,
  ctx: NarrationBuildContext
): Promise<void> {
  const toVerify = await draftRound(slotTitle, pending, writer, voice, ctx);
  if (toVerify.length === 0) return;

  const verdicts = await verifier.verifySlot({ slotTitle, voice, pages: toVerify.map((v) => v.brief) }, ctx);
  for (const { page, claims, beat } of toVerify) {
    const verdict = verdicts.pages.find((v) => v.pageId === page.pageId);
    if (!verdict) {
      reject(page, [`the verifier returned no verdict for "${page.pageId}"`], beat.sources);
      carryClaims(page, claims);
      continue;
    }
    const failures: string[] = [];
    if (!verdict.claimsSupported) failures.push("a claim in the script is not supported by the quote attached to it");
    if (!verdict.purposeAccomplished) failures.push("the page does not accomplish the purpose the beat was given");
    if (!verdict.contestedHandled) failures.push("a genuinely contested point is not handled as §4.7 rule 3 requires");
    if (failures.length > 0) {
      /* A VERIFIER REJECTION RE-RUNS PROSE + VERIFY, NOT SELECT (G-34
         lever b, "safe" in the latency model): every quote on this page
         was proven a span of a held document before the verifier saw
         it, and that proof does not expire. The writer is told what the
         verifier objected to and writes again from the same claims —
         asserting fewer of them if that is the fix. Uniform across the
         three questions on purpose: even "not supported by its quote"
         is a property of the SCRIPT against the quote, and the writer
         can drop the claim it cannot support without a fresh selection.
         Only when a page holds no grounded claim at all does it
         re-select — there is nothing to write from. */
      page.kept = { beat, verdict };
      reject(page, [`${failures.join("; ")}${verdict.notes ? ` — ${verdict.notes}` : ""}`], beat.sources);
      carryClaims(page, claims);
      continue;
    }

    /* `purposeAccomplished` is recorded on the page even though a `false`
       answer above already sent it back for another attempt: the field is
       what WS-B's `purposeFidelity` averages, and it is the statement "the
       verifier was asked F-41's question about THIS page and answered
       yes" — which run 1 could not make about any page, because nothing
       asked. It reads 1.0 across a healthy run by construction (a page
       that never gets a yes is retried, then dropped or fatal), so the
       metric earns its keep as a regression alarm rather than as a
       score: if it ever drops below 1, the question stopped being asked
       or stopped being enforced. */
    page.attempts.push({ attempt: page.attempts.length + 1, sources: beat.sources, rejected: false });
    page.result = {
      ...beat,
      purposeAccomplished: verdict.purposeAccomplished,
      ...(verdict.purposeRevised === true ? { purposeRevisedByVerifier: true } : {}),
      ...(verdict.notes ? { verifierNotes: verdict.notes } : {}),
      evidence: heldDocsOf(page.evidence),
      attempts: page.attempts
    };
  }
}

/** A page that cleared every mechanical rule this round and is ready for
 * a verifier: the brief the verifier reads, the beat it becomes if the
 * verifier says yes, and the grounded claims it carries into the next
 * round if not. */
export interface DraftedPage {
  page: PendingPage;
  claims: SelectedClaim[];
  brief: VerifyPageBrief;
  beat: NarratedBeat;
}

/**
 * The WRITING half of a round — selection (merged or split), the quote
 * gate, prose, and the structural gate — for the pages given, leaving
 * every page that did not clear a mechanical rule with a rejection
 * recorded and returning the ones that did, ready for whichever verifier
 * question the caller asks. `runSlotRound` above asks the three ordinary
 * questions; F-88's `synthesisVerify.ts` asks the synthesis question of
 * the same drafts. ONE drafting path, so a synthesis page pays the same
 * mechanical rules an ordinary page does.
 */
export async function draftRound(
  slotTitle: string,
  pending: PendingPage[],
  writer: NarrationWriterBuilder,
  voice: Voice,
  ctx: NarrationBuildContext
): Promise<DraftedPage[]> {
  const needsSelection = pending.filter((p) => p.claims === undefined);
  const needsProse = pending.filter((p) => p.claims !== undefined);
  const drafts: Draft[] = [];

  if (needsSelection.length > 0) {
    const briefs = needsSelection.map(briefFor);
    if (writer.selectAndWrite) {
      const merged = await writer.selectAndWrite({ slotTitle, voice, pages: briefs }, ctx);
      for (const page of needsSelection) {
        const reply = merged.pages.find((r) => r.pageId === page.pageId);
        if (!reply) {
          reject(page, [`the writer returned no page for "${page.pageId}" — every page in the batch must come back`], []);
          continue;
        }
        const gate = gateSelectedClaims(decodeClaimEntities(reply.claims ?? []), page);
        if (gate.issues.length === 0) {
          drafts.push({ page, claims: gate.valid, written: reply });
          continue;
        }
        /* THE QUOTE GATE FAILED ON THIS PAGE, AFTER PROSE. The script is
           spent — it may assert a claim that is not grounded — and the
           card accepts that cost. What is NOT spent is every claim that
           did resolve: they are carried to the next round, where only
           this page's prose is re-run from them. A page left with none
           re-selects, because there is nothing to write from. */
        reject(page, gate.issues, []);
        if (gate.valid.length > 0) page.claims = gate.valid;
      }
    } else {
      const selection = await writer.selectClaims({ slotTitle, voice, pages: briefs }, ctx);
      for (const page of needsSelection) {
        const gate = gateSelectedClaims(decodeClaimEntities(selection.pages.find((s) => s.pageId === page.pageId)?.claims ?? []), page);
        if (gate.issues.length > 0) {
          /* The prose call is skipped for this page entirely: writing a
             script from claims that are not grounded would only produce
             a page that fails a second time, one call later. */
          reject(page, gate.issues, []);
          continue;
        }
        page.claims = gate.valid;
        needsProse.push(page);
      }
    }
  }

  if (needsProse.length > 0) {
    const proseBriefs: ProsePageBrief[] = needsProse.map((page) => ({ ...briefFor(page), claims: page.claims! }));
    const prose = await writer.writePages({ slotTitle, voice, pages: proseBriefs }, ctx);
    for (const page of needsProse) {
      const written = prose.pages.find((p) => p.pageId === page.pageId);
      if (!written) {
        reject(page, [`the writer returned no page for "${page.pageId}" — every page in the batch must come back`], []);
        continue;
      }
      drafts.push({ page, claims: page.claims!, written });
    }
  }

  const toVerify: DraftedPage[] = [];
  for (const { page, claims, written } of drafts) {
    const sources = sourcesFor(written.usedClaims, claims, page.evidence, page.mode);
    const beat: NarratedBeat = {
      mode: page.mode,
      // The script is the other half of the entity boundary — see
      // `decodeClaimEntities`. This one is about what a listener hears:
      // a narrator does not say "ampersand a-m-p semicolon" (F-26).
      script: decodeEntities(written.script),
      sources,
      pronunciationHints: written.pronunciationHints ?? [],
      verified: true,
      /* F-50: recorded, not trusted. The verifier answers the same
         question independently below and its answer lands in
         `purposeRevisedByVerifier`. Only ever set when claimed, so a page
         that simply did its purpose carries no flag at all. */
      ...(written.purposeRevised === true ? { purposeRevised: true } : {})
    };
    page.lastBeat = beat;

    const structural = validateNarratedBeat(beat, {
      bannedPhrasePatterns: BANNED,
      heldDocs: heldDocsOf(page.evidence),
      purposeText: [page.claim, page.contextNote].filter(Boolean).join(" ")
    });
    const issues = structural.issues.map((i) => i.message);
    for (const source of sources) {
      if (looksLikeSlug(source.publication)) {
        issues.push(`publication "${source.publication}" is a tape item id, not a publication — cite the real work the quote comes from, or drop the claim`);
      }
    }
    if (issues.length > 0) {
      /* Rejected AFTER the quote gate: the claims are still grounded, so
         the next round re-runs this page's prose from them (G-34 lever
         a). A page that had none re-selects — see `carryClaims`. */
      reject(page, issues, sources);
      carryClaims(page, claims);
      continue;
    }

    /* Cleared every mechanical rule. Banked as the salvage candidate
       BEFORE the verifier is called, so a page the verifier goes on to
       reject three times is still the page F-51 keeps — a page that broke
       a substring rule is not. */
    page.kept = { beat };
    toVerify.push({ page, claims, brief: { ...briefFor(page), script: beat.script, sources }, beat });
  }
  return toVerify;
}

/**
 * F-51's salvage: the page a narration beat carries out of a slot where
 * every attempt was rejected. Prefers the last MECHANICALLY clean page
 * (quotes held, spans long enough, attribution read off the document) that
 * the verifier nonetheless refused, and falls back to the last page
 * produced at all. Returns undefined when no prose call ever produced one
 * — the unrecoverable case `NarrationWriteError` still exists for.
 *
 * `verified: false` is the whole contract. Nothing downstream reads it as
 * a licence to publish: `veracityMetrics.ts` counts these pages as
 * `unverifiedPages` and `evaluateVeracityGate` refuses on any of them,
 * naming this one. What the field buys is the eleven finished pages that
 * used to be discarded alongside it.
 */
function unverifiedResultFor(page: PendingPage, slotTitle: string): NarratedBeat | undefined {
  const salvage = page.kept ?? (page.lastBeat ? { beat: page.lastBeat, verdict: undefined } : undefined);
  if (!salvage) return undefined;

  const notes = (salvage.verdict?.notes ?? page.rejections[page.rejections.length - 1] ?? "").trim();
  console.warn(
    `writeNarration: keeping the ${page.mode} page for "${page.claim.slice(0, 80)}" (slot "${slotTitle}") UNVERIFIED after ` +
      `${NARRATION_PAGE_ATTEMPTS} rejected attempts — the Foray continues and the veracity gate decides (F-51): ${notes.slice(0, 200)}`
  );

  return {
    ...salvage.beat,
    verified: false,
    ...(typeof salvage.verdict?.purposeAccomplished === "boolean" ? { purposeAccomplished: salvage.verdict.purposeAccomplished } : {}),
    ...(salvage.verdict?.purposeRevised === true ? { purposeRevisedByVerifier: true } : {}),
    ...(notes ? { verifierNotes: notes } : {}),
    evidence: heldDocsOf(page.evidence),
    attempts: page.attempts
  };
}

export function newPage(pageId: string, beatIndex: number, claim: string, mode: NarrationMode, contextNote?: string): PendingPage {
  return {
    pageId,
    beatIndex,
    claim,
    mode,
    ...(contextNote ? { contextNote } : {}),
    evidence: emptyEvidencePack(claim),
    rejections: [],
    attempts: []
  };
}

function tapeDescription(beat: Extract<SourcedBeat, { sourcing: "tape" }>): string {
  return `segment ${beat.tape.segmentId}`;
}

/** F-82: the brief for a content beat re-written as a Hinge from the tape
 * beside it. Names each held window by where it plays, so the writer
 * cites the segment whose words it is restating and not the other one. */
function hingeFromTapeNote(windows: GatheredDoc[]): string {
  const where = (doc: GatheredDoc): string =>
    doc.tapePosition === "previous"
      ? `the segment that plays just before this page (document ${doc.docId})`
      : doc.tapePosition === "next"
        ? `the segment that plays just after this page (document ${doc.docId})`
        : `the segment beside this page (document ${doc.docId})`;
  return (
    `This page's purpose is what the tape beside it says — ${windows.map(where).join(", and ")} — and nothing in print was found for it, ` +
    `so it is written as a ${HANDOFF_MODE}: briefly restate, summarise or attribute what that tape said, citing the tape itself (that document) as the source, ` +
    "with claimText saying what the segment says and the quote either a phrase of its own words or empty. " +
    "A restatement of the tape with no tape source, or backed by an outside publication, is what gets this page rejected (F-82)."
  );
}

function briefFor(page: PendingPage): NarrationPageBrief {
  return {
    pageId: page.pageId,
    purpose: page.claim,
    mode: page.mode,
    ...(page.contextNote ? { contextNote: page.contextNote } : {}),
    ...(page.rejections.length > 0 ? { retryNote: retryNoteFrom(page.rejections) } : {}),
    evidence: page.evidence
  };
}

/** F-35: every prior rejection, in order. Run 1 overwrote this on each
 * failure, so attempt 3 was told about attempt 2 only and regularly
 * revived the fault attempt 1 was rejected for. */
export function retryNoteFrom(rejections: string[]): string {
  return (
    `${rejections.map((r, i) => `Attempt ${i + 1} was rejected for: ${r}.`).join(" ")} ` +
    "Write a corrected page that fixes every problem listed above — including the earlier ones — while keeping all other rules."
  );
}

/** Records one attempt's failure. Exactly one outcome — this or a result
 * — is recorded per page per attempt, which is what makes
 * `page.attempts.length + 1` the attempt number rather than a guess. */
export function reject(page: PendingPage, issues: string[], sources: Source[]): void {
  const rejection = issues.join("; ");
  page.rejections.push(rejection);
  page.attempts.push({ attempt: page.attempts.length + 1, sources, rejected: true, rejectionNote: rejection });
}

/** G-34: what a rejected page takes into its next round. Grounded claims
 * are carried, so the round re-runs prose only; a page with none goes
 * back to selection, because a prose call from no claims can only
 * produce a hand-off and a merged call costs the same request. */
export function carryClaims(page: PendingPage, claims: SelectedClaim[]): void {
  if (claims.length > 0) page.claims = claims;
  else delete page.claims;
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

  if (valid.length === 0 && (page.mode === "Patch" || page.mode === "Carry")) {
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
export function isTapeClaim(claim: SelectedClaim, page: Pick<PendingPage, "mode" | "evidence">): boolean {
  if (!modeMayCiteTape(page.mode)) return false;
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
export function sourcesFor(usedClaims: number[] | undefined, claims: SelectedClaim[], pack: EvidencePack, mode: NarrationMode): Source[] {
  const out: Source[] = [];
  const seen = new Set<number>();
  for (const index of usedClaims ?? []) {
    if (!Number.isInteger(index) || index < 0 || index >= claims.length || seen.has(index)) continue;
    seen.add(index);
    const claim = claims[index]!;
    const doc = pack.docs.find((d) => d.docId === claim.docId);
    if (!doc) continue;
    const segmentId = isTapeClaim(claim, { mode, evidence: pack }) ? segmentIdOfTapeDoc(doc.docId) : null;
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
        if (beat.sourcing === "narration") out.push(beat.narration);
        else if (beat.connectiveNarration) out.push(beat.connectiveNarration);
      }
    }
  }
  return out;
}

export { disclosureNarratedBeat, MODE_CHAR_BANDS, containsContestedLanguage };
