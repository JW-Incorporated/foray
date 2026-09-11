import type { Beat, BeatSeed, DeepenedAct } from "../types/spine";
import type {
  NewSegment,
  SourcedAct,
  SourcedBeat,
  SourcedSlot,
  SourceBeatsResult,
  SourcingTrace,
  TapePointer,
  TapeRelevanceInput,
  Tier1Gate,
  Tier1TraceRow,
  Tier2Gate,
  Tier2TraceRow,
  TranscriptionQueueCandidate
} from "../types/tapeSourcing";
import { validateSourcing } from "../types/tapeSourcing";
import type { AudioSourceResolver, MintedSegmentSource } from "./audioSourceLookup";
import { whyFromClaim } from "./mintedSegmentCopy";
import {
  familiesOfNodes,
  familyGateAllows,
  isOnTopic,
  taxonomyNodesForItemId,
  taxonomyNodesForShowId,
  taxonomyRoot,
  unionNodes
} from "./taxonomyFamily";

/* ------------------------------------------------------------------------- */
/* THE ASSEMBLY RULES SOURCING KEEPS, MIRRORED FROM THE GATE THAT OWNS THEM.
 *
 * `tools/foray/check-forays.mjs` IS THE AUTHORITY on every number below, and
 * `docs/curation/narration-craft.md` §0 is the authority on that file. Nothing
 * here relaxes, reinterprets or extends any of them; they are copied so that
 * §4.5 can decline to build a Foray the checker will certainly refuse at §4.9,
 * five stages later, when the only remedy left is to throw the run away.
 *
 * WHY COPIED RATHER THAN IMPORTED. `check-forays.mjs` is an `.mjs` build script
 * with no TypeScript build step, and Vitest cannot load it on every checkout —
 * its own loader percent-encodes a space in the checkout path, which this
 * repository's working copy has (see `RunPipelineDeps.finalize`, and the same
 * mirroring for `MAX_WHY_LINE_WORDS` in `runPipeline.ts`). A mirrored constant
 * with the authority named beside it is the pattern this codebase already uses
 * for that; `check-forays.test.mjs` is what pins the numbers themselves.
 *
 * F-73 IS WHY THE D-TIER ONES ARE HERE AT ALL. Until now sourcing mirrored M4
 * and nothing else, and the duration rules were left to whatever length a window
 * happened to be: run 2 attempt 5's act-1 candidate came out with a 76.1 s mean
 * and a 15.6 s interquartile range and was refused on D2, D3, D5 and M4's
 * runtime clause at once. */

/** M4: no one episode over this share of a Foray's segments — or of its tape
    SECONDS, which is the clause F-73 added a gate for (`m4RuntimeAllows`). */
export const M4_ITEM_SHARE_MAX = 0.25;

/** D2: a segment under this is "short", and at most two may run consecutively
    before a segment of `D2_RECOVERY_SEC` or more is required. */
export const D2_SHORT_SEC = 60;
/** The recovery segment D2 demands after two short ones. Sourcing cannot
    PROMISE one — it does not know which beat will be next, or whether the Foray
    ends here — so it never lets the debt be taken on: see `d2RunAllows`. */
export const D2_RECOVERY_SEC = 150;

/** D3: the floor under a Foray's MEAN segment duration. */
export const D3_MEAN_FLOOR_SEC = 90;
/**
 * How many placed segments the running-mean gate waits for.
 *
 * The same exemption, for the same reason, as `m4SegmentCapFor`'s `max(1, …)`:
 * with one or two segments the mean is whatever those one or two happen to be,
 * and the answer to a tape-starved Foray is more tape, not less. Refusing the
 * second segment for being short would take the mean no closer to the floor and
 * cost the Foray a piece of tape it needs. Three is the smallest count at which
 * a refusal can actually move the number the rule reads.
 */
export const D3_MEAN_MIN_PLACED = 3;

/** D5, first clause: three consecutive durations within +/- this of each other
    are a uniformity violation. The PAIRWISE reading, which is the one
    `check-forays.mjs` gates on — see its own `d5Triples` note on why. */
export const D5_TOLERANCE = 0.2;
/**
 * D5, second clause: the interquartile range of the durations must reach this.
 *
 * MIRRORED FOR THE READER, DELIBERATELY NOT GATED HERE. An IQR is a property of
 * the whole finished multiset and it is not monotone in a single placement: with
 * three or four segments placed almost any candidate lowers it, so a
 * placement-time refusal would decline tape early on precisely in order to
 * protect a number that only becomes meaningful later — and a Foray with less
 * tape has a worse IQR, not a better one. What sourcing does about D5's spread
 * instead is `D_TARGET_LADDER_SEC`: it asks consecutive placements for
 * deliberately different lengths, so the spread is built rather than filtered
 * for. This number is what that ladder is sized against.
 */
export const D5_IQR_FLOOR_SEC = 45;

/**
 * THE LENGTHS §4.5 ASKS CONSECUTIVE TAPE PLACEMENTS TO GROW TOWARDS (F-73).
 *
 * WHY A LADDER AND NOT ONE NUMBER. One target makes every segment the same
 * length, which satisfies D3's mean and fails both of D5's clauses — the exact
 * trade the old 60-120 s band made in reverse. The D rules want a mean over 90 s
 * AND a spread, so the targets have to differ from each other by more than D5's
 * own tolerance, and they do: no two adjacent entries are within +/-20 % (the
 * closest pair is 135/165, a ratio of 1.222), so a run of placements that all
 * reach their targets cannot produce a uniform triple.
 *
 * HOW THE FOUR NUMBERS WERE CHOSEN. Sorted, any four consecutive entries are
 * 105/135/165/210, whose R-7 interquartile range is 48.75 s — clear of
 * `D5_IQR_FLOOR_SEC` with a little room, and their mean is 153.75 s, clear of
 * `D3_MEAN_FLOOR_SEC` with a lot. The top of the ladder stays under
 * `MAX_TAPE_SEGMENT_SEC` and under check-forays' own L4 240 s soft maximum, so
 * reaching a target can never itself require a `long_reason`.
 *
 * IT IS A TARGET, NOT A LENGTH. `cutWindowToSegment` only grows while the tape
 * is still saying the claim's words, so most spans stop short of their target —
 * which is additional spread, not a failure. Indexed by how many tape segments
 * the Foray has already placed, so the sequence is deterministic for a given
 * run and a replay produces the same cuts.
 */
export const D_TARGET_LADDER_SEC = [105, 165, 135, 210];

/** The length the next tape placement grows towards. */
export function tapeTargetFor(placedTapeSegments: number): number {
  return D_TARGET_LADDER_SEC[placedTapeSegments % D_TARGET_LADDER_SEC.length]!;
}

/**
 * HOW MANY SEGMENTS ONE EPISODE MAY SUPPLY, given how many tape segments this
 * Foray has PLACED so far. The single place either tier asks the question
 * (F-70).
 *
 * WHY THE DENOMINATOR IS THE PLACED TAPE COUNT AND NOT THE BEAT COUNT. M4 is a
 * share of the FINAL Foray's segments, and sourcing cannot know that number
 * while it is still deciding beat by beat. Until F-70 this was derived from the
 * total BEAT count up front — `max(1, floor(totalBeats * 0.25))` — and that is
 * the wrong denominator by roughly the tape-hit rate: run 2 attempt 4b sourced
 * 5 tape segments from 24 beats, so the cap read 6 while the number that
 * mattered was 1. Two segments from *Practical AI* sailed through and the
 * checker reported "40.0 % of segments and 42.2 % of runtime, over the 25 %
 * cap". A cap that cannot bind is not a cap.
 *
 * WHY ASKING IT AT PLACEMENT TIME IS SAFE. `floor(placed * 0.25)` never
 * DECREASES as the Foray grows, so a second segment admitted when the count
 * would be `n` of `p` stays admissible at every larger `p`. Every later
 * placement is re-asked against its own, larger denominator. So the invariant
 * "no episode is over its share" holds at the end without sourcing ever
 * needing to know where the end is — and the concrete rule that falls out is
 * readable: an episode's SECOND segment needs `floor(p * 0.25) >= 2`, i.e. a
 * Foray holding at least 8 tape segments; its third needs 12.
 *
 * `max(1, …)` is the exemption every episode gets for its FIRST segment. A
 * Foray with 3 tape segments fails M4's count clause whichever episodes they
 * came from (1/3 is 33 %), and the answer to that is more tape, not less —
 * refusing an episode's only segment would take the Foray further from the
 * cap, not closer. So this bounds over-representation, which is what M4 is
 * about and what was actually failing; it does not pretend to make a
 * tape-starved Foray pass.
 *
 * RUNTIME IS DELIBERATELY NOT GATED HERE. M4 also caps an episode's share of
 * tape SECONDS, and with one segment per episode that share is decided by how
 * long each window happens to be — a single long segment among four short ones
 * is over 25 % of runtime with no episode repeated. Refusing an episode's only
 * segment for being long would cost the Foray tape without moving any other
 * episode's share, so sourcing bounds the count and `check-forays.mjs` remains
 * the authority on the runtime clause, exactly as before.
 */
export function m4SegmentCapFor(placedTapeSegments: number): number {
  return Math.max(1, Math.floor(placedTapeSegments * M4_ITEM_SHARE_MAX));
}
import {
  findTier1Match,
  loadSegmentPool,
  requiredOverlapFor,
  scoreSegmentsAgainstClaim,
  TIER1_MATCH_THRESHOLD,
  type SegmentRecord,
  type SegmentWindowText
} from "./segmentPoolLookup";
import {
  bestTranscriptArchiveCandidate,
  cueWindowText,
  cutWindowToSegment,
  deriveItemId,
  findTranscriptArchiveMatch,
  loadTranscriptArchive,
  seedFloorDecided,
  selectTapeWindow,
  tapeWindowIsRelevant,
  titleTokenScore,
  MAX_TAPE_SEGMENT_SEC,
  MIN_TAPE_SEGMENT_SEC,
  NullTranscriptCueProvider,
  TIER2_MATCH_THRESHOLD,
  TIER2_WINDOW_MIN_SHARE,
  TIER2_WINDOW_MIN_TERMS,
  type TapeSpan,
  type TapeWindow,
  type TranscriptCue,
  type TranscriptCueProvider,
  type TranscriptDigestEntry
} from "./transcriptArchiveLookup";
import {
  NullTranscriptTextIndex,
  TRANSCRIPT_TEXT_CANDIDATES,
  type TranscriptTextCandidate,
  type TranscriptTextIndex
} from "./transcriptTextIndex";
import { tokenizeForSourcing } from "./catalogueLookup";

/**
 * §4.5-4.6 orchestrator (docs/curation/generation-architecture.md §4.5,
 * §4.6): takes §4.4's `DeepenedAct[]` and decides, for every beat, HOW it
 * is sourced — real tape (resolved to a §4.6 pointer) or narration
 * (flagged Patch/Carry for §4.7, which this module does not write).
 *
 * WHY NO LLM COLLABORATOR HERE, UNLIKE §4.3's SpineBuilder / §4.4's
 * DeepenActBuilder (a deliberate departure this stage's own task brief
 * explicitly allows, and asks to be flagged as a finding): §4.5's task
 * brief says the LLM builder pattern applies "likely only for the
 * semantic-match step against segments.json, not for the deterministic
 * anchor/pointer math," and explicitly prefers "a deterministic scorer
 * with a confidence threshold over calling out to the LLM (if needed at
 * all)." `segmentPoolLookup.ts` and `transcriptArchiveLookup.ts`
 * implement exactly that: a tokenize-and-score matcher (reusing
 * `catalogueLookup.ts`'s tokenizer) against a fixed threshold, which is
 * enough to pass or fail every §4.5 tier deterministically. There is
 * therefore no LLM call in this module's normal path, no
 * `*Builder`/`Stub*`/`Anthropic*`/`create*` quad, and no
 * `defaultBudgetGuard.checkAndRecord(...)` call site — none of the three
 * would have anything to guard, and adding one that always records a
 * zero-cost stub event would be dead ceremony, not safety. If a future
 * pass finds the deterministic threshold too blunt for ambiguous claims,
 * an LLM tie-breaker slots in cleanly behind the SAME `findTier1Match` /
 * `findTranscriptArchiveMatch` call sites this module already isolates
 * matching behind — that is the seam to extend, not a reason to build
 * an unused builder quad today.
 *
 * §1.1 / §4.6 SEEK-AND-STOP: nothing in this module fetches, downloads,
 * or persists an audio byte. `NullTranscriptCueProvider` is the default
 * cue source and always returns `null` (see its doc comment) — the ONLY
 * network-adjacent capability plugged in here is a caller-supplied
 * `TranscriptCueProvider`, and the interface itself can only return
 * already-on-disk TEXT cues, never audio. There is no code path in this
 * module, its default provider, or its two lookup modules that opens an
 * HTTP connection or writes a byte to `data-local/` — verified
 * structurally by `sourceBeats.noFetch.test.ts` (module-source grep for
 * fetch/http/download call sites), not asserted only in prose.
 *
 * WHAT GENERATION RUN 1 CHANGED HERE (fix plan WS-C; findings F-06, F-23,
 * F-24, F-29, F-33, F-38). Attempt 4 finished with 5 of 22 tape anchors on
 * topic: a Kansas City walkway beat took a British hearth-cooking segment, a
 * barbecue show and four geology episodes turned up in a Foray about
 * engineering disasters, and an analytical beat — a thesis no recording can be
 * about — was given tape at all. Every one of those was this module matching
 * words against a PROXY for the tape (a title, an 18-word curator note) with no
 * check that the two were about the same subject. Four things changed, none of
 * them a new model call:
 *
 *   1. a beat §4.4 tagged `kind: "argument"` skips the tape search entirely;
 *   2. tier 1 scores the claim against the TRANSCRIPT the segment was cut from
 *      when a cue provider can supply it, falling back to metadata only when it
 *      cannot;
 *   3. tier 2 must find the claim's words spoken in one STRETCH of the tape,
 *      not merely somewhere in the same hour of it, and what it mints is that
 *      stretch cut to whole cues with a minimum duration instead of a few
 *      seconds around a phrase (F-61 later moved the relevance judgement onto
 *      the window itself and the anchors onto the tape's own words — see the
 *      tier-2 block in `resolveOneBeat`);
 *   4. a candidate must share a taxonomy family — a LINEAGE, see
 *      `taxonomyFamily.ts` — with the Foray's resolved topic, which is why
 *      `runPipeline.ts` now resolves the topic before sourcing.
 *
 * The topic gate reads `data/taxonomy.json`, `data/catalog.json`,
 * `data/segment-sources.json` (and, for a numeric breadth show id only,
 * `data/breadth-classification.json`) through `taxonomyFamily.ts`. All are
 * committed catalogue files, same as `data/segments.json`; the SEEK-AND-STOP
 * property above is unchanged.
 */

export interface SourceBeatsOptions {
  segmentPool?: SegmentRecord[];
  transcriptArchive?: TranscriptDigestEntry[];
  cueProvider?: TranscriptCueProvider;
  /**
   * §4.5 tier-2's CANDIDATE SEARCH over what the archive actually says
   * (`transcriptTextIndex.ts`; fix plan WS-H, findings F-06 and F-49).
   *
   * Defaults to `NullTranscriptTextIndex`, which returns nothing — so a caller
   * that supplies no index (CI, every test written before WS-H) gets exactly
   * the title-metadata path tier 2 has always walked, and a machine that holds
   * the transcript bodies gets a search over the text. Same shape and same
   * default-to-honest-nothing contract as `cueProvider` above.
   */
  textIndex?: TranscriptTextIndex;
  /**
   * The Foray's resolved `data/taxonomy.json` node (§4.5's TOPIC GATE).
   *
   * Supplied by `runPipeline.ts`, which now resolves the topic BEFORE sourcing
   * for exactly this reason. Omitted, the gate is inert and sourcing behaves as
   * it did before run 1 — which is the right default for a caller that has no
   * topic to gate on, and never happens in a real run.
   */
  topic?: string | null;
  /** Repo root for the catalogue reads the topic gate makes. Tests only. */
  root?: string;
  /**
   * Resolves the `data/segment-sources.json` row for an episode tier 2 wants to
   * mint a segment from (`audioSourceLookup.ts`).
   *
   * INERT WHEN OMITTED, like `topic` above and for the same reason: a caller
   * with no way to resolve audio behaves exactly as this module did before the
   * resolver existed. `runPipeline.ts` always supplies one, and with it in place
   * tier 2 will not mint tape for an episode whose audio cannot be honestly
   * registered — a segment nothing can play is not tape, and
   * `check-forays.mjs` rejects the Foray that references it ("nothing can
   * resolve its audio").
   */
  audioSourceFor?: AudioSourceResolver;
}

/**
 * Sources every beat of every deepened act. Pure function over its
 * inputs (plus whatever `cueProvider` is asked to resolve) — no network,
 * no writes, matching §1.1/§4.6.
 */
export function sourceBeats(deepenedActs: DeepenedAct[], options: SourceBeatsOptions = {}): SourceBeatsResult {
  const segmentPool = options.segmentPool ?? loadSegmentPool();
  const transcriptArchive = options.transcriptArchive ?? loadTranscriptArchive();
  const cueProvider = options.cueProvider ?? new NullTranscriptCueProvider();
  const textIndex = options.textIndex ?? new NullTranscriptTextIndex();

  const newSegments: NewSegment[] = [];
  /* One row per episode a segment was minted from, deduplicated by item id:
     `check-forays.mjs` requires exactly one registry entry per item id, and two
     beats commonly take two segments from one episode. */
  const newSegmentSources = new Map<string, MintedSegmentSource>();
  const transcriptionQueueCandidates: TranscriptionQueueCandidate[] = [];
  const mintedIds = new Set<string>(segmentPool.map((s) => s.id));
  /* What THIS Foray has already committed to. Both are Foray-wide, not
     per-slot, because both rules they serve span the whole running order:
       - `usedSegmentIds` — a segment may not play twice;
       - `lastStartByItem`  — segments from one episode must play in ascending
         time order (check-forays' M3), so an episode already heard at 1964 s
         cannot later be joined at 900 s.
     A set scoped to a slot or an act would satisfy neither. */
  const usedSegmentIds = new Set<string>();
  const lastStartByItem = new Map<string, number>();
  /* M4: no single episode may be more than a quarter of a Foray — see
     `m4SegmentCapFor` for the cap, its denominator, and why the denominator is
     the count of tape segments PLACED rather than the beat count it used to be
     (F-70). `placedTapeCount` is that denominator: every tape placement, tier 1
     or tier 2, increments it. */
  const usedCountByItem = new Map<string, number>();
  /* And the D-tier ledger (F-73): the durations of everything placed, in playing
     order, plus the tape seconds each episode has contributed. D2, D3 and D5 are
     functions of the first; M4's runtime clause is a function of both. Foray-wide
     for the same reason as the two above — the running order they judge is the
     whole Foray's. */
  const placedDurations: number[] = [];
  const placedSecByItem = new Map<string, number>();
  /* Which episode each placement came from and where in it, positionally
     parallel to `placedDurations` — what the post-placement spread pass (F-73,
     D5) needs to re-ask M3 and M4 about a Foray it is CHANGING rather than
     extending. The running gates never need it, because a candidate's own item
     id is in their hands already. */
  const placed: PlacedSegment[] = [];
  const recuts: TapeRecut[] = [];

  const forayTopic = options.topic ?? null;
  const state: SourcingState = {
    segmentPool,
    transcriptArchive,
    cueProvider,
    textIndex,
    windowText: makeSegmentWindowText(transcriptArchive, cueProvider),
    forayTopic,
    root: options.root,
    audioSourceFor: options.audioSourceFor,
    mintedIds,
    newSegments,
    newSegmentSources,
    transcriptionQueueCandidates,
    usedSegmentIds,
    lastStartByItem,
    usedCountByItem,
    placedTapeCount: 0,
    placedDurations,
    placedSecByItem,
    placed,
    recuts
  };
  const tapeRelevance: TapeRelevanceInput[] = [];
  /* One row per narration-degraded beat, saying what each tier saw and which
     gate refused it (F-49). The two arrays partition the Foray's beats. */
  const sourcingTrace: SourcingTrace[] = [];

  const acts: SourcedAct[] = deepenedActs.map((act, actIndex) => {
    const slots: SourcedSlot[] = act.slots.map((slot, slotIndex) => {
      // Resolve tape-or-not for every beat in the slot FIRST, because the
      // Patch/Carry decision needs to know whether ANY beat in this slot —
      // not just this one — ended up tape-sourced (§4.5: "pick based on
      // whether the SLOT the beat belongs to has any other tape-sourced
      // beats").
      const resolutions = slot.beats.map((beat) => resolveOneBeat(beat, state));
      const slotHasTape = resolutions.some((r) => r.kind === "tape");

      const beats: SourcedBeat[] = slot.beats.map((beat, beatIndex) => {
        const resolution = resolutions[beatIndex]!;
        if (resolution.kind === "tape") {
          tapeRelevance.push({
            actIndex,
            slotIndex,
            beatIndex,
            claim: beat.claim,
            itemId: resolution.pointer.itemId,
            segmentId: resolution.pointer.segmentId,
            tier: resolution.pointer.tier,
            taxonomyNodeIds: resolution.nodes,
            families: familiesOfNodes(resolution.nodes),
            forayTopic,
            forayFamily: taxonomyRoot(forayTopic),
            onTopic: isOnTopic(forayTopic, resolution.nodes, state.root),
            /* WS-L (F-63): which episode the spine wrote this beat from, and
               whether that is where the tape came from. The pair is how a run
               can be asked "did reading the tape first actually produce the
               tape?" without anyone re-deriving the join by hand. */
            seededEpisode: beat.seed?.episodeId ?? null,
            seedWindowWon: resolution.fromSeed,
            /* F-72: and whether the seed window's share-only floor is what let
               that tape through — the field a run log counts to say how often
               the rule decided. */
            seedFloor: resolution.seedFloor
          });
          return { sourcing: "tape", claim: beat.claim, exploration: beat.exploration, kind: beat.kind, tape: resolution.pointer };
        }
        sourcingTrace.push({
          actIndex,
          slotIndex,
          beatIndex,
          claim: beat.claim,
          outcome: resolution.diagnosis.outcome,
          tier1: resolution.diagnosis.tier1,
          tier2: resolution.diagnosis.tier2
        });
        // Narration: Patch when this slot has other tape-sourced beats
        // (this beat supplies what that tape misses); Carry when the
        // slot has no tape at all (this beat IS the content).
        const mode = slotHasTape ? "Patch" : "Carry";
        const reason = slotHasTape
          ? `${resolution.reason} Slot "${slot.title}" has other tape-sourced beats — this beat patches what the slot's tape misses.`
          : `${resolution.reason} Slot "${slot.title}" has no tape-sourced beats at all — this beat carries the content alone.`;
        return { sourcing: "narration", claim: beat.claim, exploration: beat.exploration, kind: beat.kind, narration: { mode, reason } };
      });

      return { title: slot.title, beats };
    });

    return { title: act.title, slots };
  });

  /* EVERY BEAT HAS BEEN PLACED; THE ONE D-TIER RULE THAT COULD NOT BE ASKED
     UNTIL NOW IS ASKED HERE (F-73, D5's interquartile clause). */
  liftDurationSpread(state, tapeRelevance);

  const validation = validateSourcing(deepenedActs, acts);
  if (!validation.valid) {
    // This should be structurally unreachable — resolveOneBeat/the map
    // above never drop, add, or reorder a beat — but fail loudly rather
    // than silently violate §4.5's own guardrail if it ever is.
    throw new Error(`sourceBeats violated the beat-preservation guardrail: ${validation.issues.map((i) => i.message).join("; ")}`);
  }

  return { acts, newSegments, transcriptionQueueCandidates, tapeRelevance, sourcingTrace, newSegmentSources: [...newSegmentSources.values()] };
}

/**
 * One line per slot: how much of it is tape, how much is narration, and the
 * single most common reason its narrated beats got no tape (F-49).
 *
 * A pure function returning strings rather than something that prints: the
 * pipeline prints these, tests read them, and a batch driver could put them in
 * a report without this module knowing about any of the three.
 *
 * THE "TOP REASON" IS WHERE THE BEATS GOT FURTHEST. A beat that never reached
 * tier 2 is reported against tier 1; a beat whose search reached a real episode
 * is reported against tier 2, because that is the gate whose threshold a human
 * would go and look at. Ties break toward the reason that appears first in the
 * slot, so the line is stable for a given slot.
 */
export function summarizeSourcing(result: SourceBeatsResult): string[] {
  const traceByBeat = new Map<string, SourcingTrace>();
  for (const t of result.sourcingTrace) traceByBeat.set(`${t.actIndex}:${t.slotIndex}:${t.beatIndex}`, t);

  const lines: string[] = [];
  result.acts.forEach((act, actIndex) => {
    act.slots.forEach((slot, slotIndex) => {
      let tape = 0;
      const reasons = new Map<string, number>();
      slot.beats.forEach((beat, beatIndex) => {
        if (beat.sourcing === "tape") {
          tape += 1;
          return;
        }
        const trace = traceByBeat.get(`${actIndex}:${slotIndex}:${beatIndex}`);
        const reason = trace ? topReasonFor(trace) : "unknown";
        reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
      });
      const narration = slot.beats.length - tape;
      let top: string | null = null;
      let topCount = 0;
      for (const [reason, count] of reasons) {
        if (count > topCount) {
          top = reason;
          topCount = count;
        }
      }
      lines.push(
        `source: act ${actIndex + 1} slot ${slotIndex + 1} "${slot.title}" — ${tape} tape / ${narration} narration` +
          (top ? `; top reason: ${top} (${topCount} of ${narration})` : "")
      );
    });
  });
  return lines;
}

/** The one label that best explains a narrated beat — see `summarizeSourcing`. */
export function topReasonFor(trace: SourcingTrace): string {
  if (trace.outcome === "skipped:argument") return "skipped:argument";
  if (trace.tier2 && trace.tier2.bestEpisodeTitle) return `tier2:${trace.tier2.gate}`;
  if (trace.tier1) return `tier1:${trace.tier1.gate}`;
  return trace.tier2 ? `tier2:${trace.tier2.gate}` : "no-tape";
}

/** Everything `resolveOneBeat` needs, gathered once so the beat-level function
 * takes one argument instead of eleven. Mutable members are the Foray-wide
 * ledgers documented in `sourceBeats` above. */
interface SourcingState {
  segmentPool: SegmentRecord[];
  transcriptArchive: TranscriptDigestEntry[];
  cueProvider: TranscriptCueProvider;
  /** See `SourceBeatsOptions.textIndex` — the Null index makes tier 2's
   * candidate search exactly the title search it was before WS-H. */
  textIndex: TranscriptTextIndex;
  windowText: SegmentWindowText;
  /** The Foray's resolved `data/taxonomy.json` node — the gate's left-hand
   * side. Null when the caller had none, which makes the gate inert. */
  forayTopic: string | null;
  root: string | undefined;
  /** See `SourceBeatsOptions.audioSourceFor` — undefined leaves tier 2 exactly
   * as it was before a minted segment had to be resolvable to audio. */
  audioSourceFor: AudioSourceResolver | undefined;
  mintedIds: Set<string>;
  newSegments: NewSegment[];
  newSegmentSources: Map<string, MintedSegmentSource>;
  transcriptionQueueCandidates: TranscriptionQueueCandidate[];
  usedSegmentIds: Set<string>;
  lastStartByItem: Map<string, number>;
  usedCountByItem: Map<string, number>;
  /** How many tape segments this Foray has placed — M4's denominator. Mutated
   * by `placeTape`, which is the only thing allowed to move any of these. */
  placedTapeCount: number;
  /** Every placed segment's duration, IN PLAYING ORDER — beats are resolved in
   * playing order here, and `check-forays.mjs` reads D2/D3/D5 off exactly this
   * sequence (segments only; narration and jingles are not cuts). The D-tier
   * ledger F-73 added is a function of this array and nothing else. */
  placedDurations: number[];
  /** Tape SECONDS per episode — M4's second clause, which counts seconds rather
   * than segments and which #569 deliberately left to the checker (F-73). */
  placedSecByItem: Map<string, number>;
  /** Where each placement came from, positionally parallel to
   * `placedDurations` — see the declaration in `sourceBeats`. */
  placed: PlacedSegment[];
  /** The tier-2 placements the spread pass may re-cut, in placing order. A tier
   * 1 hit is not in here: its length is a curator's decision, not this stage's
   * (`liftDurationSpread`). */
  recuts: TapeRecut[];
}

/** One placement's identity, for the rules the spread pass has to re-ask about
 * the whole finished running order rather than about one more candidate. */
interface PlacedSegment {
  itemId: string;
  startSec: number;
}

/**
 * EVERYTHING NEEDED TO CUT ONE TIER-2 PLACEMENT AGAIN (F-73, D5's spread).
 *
 * The window a segment was cut from, the claim it was cut for, and the objects
 * the cut is written into. Recorded at placement time because none of it can be
 * recovered afterwards: the cues came from a provider call this pass will not
 * repeat, and the window was chosen by a relevance search this pass must not
 * re-run — a re-cut changes a segment's LENGTH and never what it is about.
 */
interface TapeRecut {
  claim: string;
  cues: TranscriptCue[];
  window: TapeWindow;
  itemId: string;
  /** This placement's index in `placedDurations` / `placed`. */
  placement: number;
  /** The episode's own length where the feed states one — the ceiling a longer
   * cut may not pass, and what `referenceDurationSec` is re-derived from. */
  feedDurationSec: number | null;
  /** The two records a new cut is written into. Held by reference: they are the
   * very objects `acts` and `newSegments` carry out of this module. */
  pointer: TapePointer;
  segment: NewSegment;
}

/** The trace rows a narration-degraded beat carries out with it — the caller
 * adds the beat's own position and claim (F-49). */
interface SourcingDiagnosis {
  outcome: "skipped:argument" | "no-tape";
  tier1: Tier1TraceRow | null;
  tier2: Tier2TraceRow | null;
}

type BeatResolution =
  /** `nodes` — every taxonomy node this anchor resolved to, the same union the
   * gate judged it on and the one WS-B's metric recomputes from disk.
   * `fromSeed` — the tape came from the episode §4.3 seeded the beat from
   * (WS-L). `seedFloor` — the seed window's share-only floor is what admitted
   * this window (F-72); absent whenever the searching floor would have taken it
   * anyway, so counting it counts decisions rather than applications. */
  | { kind: "tape"; pointer: TapePointer; nodes: string[]; fromSeed: boolean; seedFloor?: "share-only" }
  | { kind: "narration"; reason: string; diagnosis: SourcingDiagnosis };

/**
 * Whether a pool segment may be used, and if not, WHICH rule refused it.
 *
 * Extracted from `findTier1Match`'s inline predicate so the trace can name the
 * gate that stopped the best candidate instead of reporting a bare "no match"
 * (F-49). The check order is unchanged, and `tier1IsUsable` below is the same
 * predicate the search has always been given — a boolean view of this one.
 */
function tier1VetoFor(
  segment: SegmentRecord,
  state: SourcingState,
  options: { relaxSpread?: boolean } = {}
): Exclude<Tier1Gate, "no-candidates" | "threshold"> | null {
  /* THE TOPIC GATE (F-29). The pool has always carried a `topic` node per
     segment and the Foray has always had one; nothing compared them, which is
     how a Kansas City walkway beat took a British hearth-cooking segment.
     Checked inside the ranked walk, like the assembly rules below, so the
     search falls through to the next ON-TOPIC candidate instead of giving up. */
  if (!familyGateAllows(state.forayTopic, nodesForSegment(segment, state), state.root)) return "topic-lineage";
  /* Already spoken for by an earlier beat of this Foray — F-29's "exhaustion of
     the one relevant episode", which is what sent run 1 to a griddle segment. */
  if (state.usedSegmentIds.has(segment.id)) return "exhausted";
  if (!m4ShareAllows(segment.item_id, state)) return "m4-share";
  if (!m3OrderAllows(segment.item_id, segment.start_sec, state)) return "m3-order";
  /* And the D-tier ledger (F-73). A pool segment arrives with its length already
     decided, so unlike tier 2 there is nothing to grow — the question is only
     whether THIS length fits what the Foray has placed, and the ranked walk falls
     through to the next candidate when it does not. Asked last because it is the
     only veto here that depends on the candidate's duration rather than its
     identity. */
  return durationVetoFor(segment.item_id, segment.end_sec - segment.start_sec, state, options);
}

function tier1IsUsable(segment: SegmentRecord, state: SourcingState, options: { relaxSpread?: boolean } = {}): boolean {
  return tier1VetoFor(segment, state, options) === null;
}

/* THE TWO FORAY-WIDE ASSEMBLY RULES, ASKED THE SAME WAY BY BOTH TIERS (F-70).
   They were inline in `tier1VetoFor` and tier 2 — which MINTS a segment rather
   than picking one from the pool — never asked them at all. Run 2 attempt 4b is
   what that costs: two seeded beats in one slot both took tape from *Practical
   AI: Federated learning in production, part 2*, the later beat's window
   (1019-1101 s) placed after the earlier beat's (1925-2020 s), and the finished
   Foray failed check-forays on M3 AND on M4 with one episode at 40 % of its
   segments. Extracted here so there is one statement of each rule and both
   tiers call it. */

/** Whether one more segment from `itemId` keeps the episode inside M4's share
 * of this Foray — see `m4SegmentCapFor` for why the question is asked against
 * the count this placement would make it, not against a cap fixed up front. */
function m4ShareAllows(itemId: string, state: SourcingState): boolean {
  const used = state.usedCountByItem.get(itemId) ?? 0;
  return used + 1 <= m4SegmentCapFor(state.placedTapeCount + 1);
}

/** Whether a segment starting at `startSec` may follow what this Foray has
 * already placed from the same episode: M3 asks that segments from one episode
 * play in ascending time order, and beats are placed in playing order here. */
function m3OrderAllows(itemId: string, startSec: number, state: SourcingState): boolean {
  const lastStart = state.lastStartByItem.get(itemId);
  return lastStart === undefined || startSec >= lastStart;
}

/* THE D-TIER LEDGER (F-73). Four rules that read a candidate's DURATION against
   what this Foray has already placed, asked by both tiers at the point where the
   duration is known, and every one of them a fall-through: a candidate refused
   here is passed over for the next one, exactly like `m4-share` and `m3-order`,
   because the answer to "this length would break the running order" is a
   different piece of tape and not narration.

   THEY ARE NOT A SECOND OPINION ABOUT THE RULES. Each is `check-forays.mjs`'s own
   clause asked one placement early, and each is either exactly as strict as the
   checker (D3, M4's runtime clause) or deliberately STRICTER in the one direction
   sourcing cannot see (D2, D5's triple clause) — never looser. Where sourcing is
   stricter the comment says so and says why. */

/** Which D-tier rule a candidate duration would break, or `null`. */
type DurationGate = "d2-short-run" | "d3-mean" | "d5-uniform" | "m4-runtime";

/**
 * THREE OF THE FOUR ARE HARD; `d5-uniform` IS A PREFERENCE, AND THAT DISTINCTION
 * IS THE ONE JUDGEMENT CALL IN THIS LEDGER.
 *
 * The other three refuse tape whose LENGTH does damage no later placement can
 * undo: a second consecutive short segment starts a run D2 will not forgive, a
 * short segment below the running mean pulls D3's average down for good, and an
 * episode past its quarter of the seconds is past it. Declining them costs the
 * beat its tape and that is the right trade — the checker's verdict on any of them
 * is fatal to the whole run.
 *
 * D5's triple clause is different, because it is a statement about SIMILARITY
 * rather than about a length being wrong. Refusing every candidate that resembles
 * its two predecessors can cost a Foray nearly all of its tape: a pool whose
 * segments are all one length (the real `data/segments.json` is not, but a
 * fixture, a single show, or a thin subject can be) would place two segments and
 * then refuse everything, and a two-segment Foray fails M4 and D5's own
 * interquartile clause worse than a metronomic one does. So the clause is asked
 * FIRST and relaxed LAST: when a beat can be sourced without a uniform triple, it
 * is, and when the only tape available makes one, the tape wins and
 * `check-forays.mjs` gets to make the call with the whole running order in front
 * of it. It therefore never costs a beat its tape — it only ever chooses between
 * candidates.
 *
 * `relaxSpread` is that second pass. Nothing else in this file relaxes anything.
 */
function durationVetoFor(
  itemId: string,
  durationSec: number,
  state: SourcingState,
  { relaxSpread = false }: { relaxSpread?: boolean } = {}
): DurationGate | null {
  if (!d2RunAllows(durationSec, state)) return "d2-short-run";
  if (!d3MeanAllows(durationSec, state)) return "d3-mean";
  if (!relaxSpread && !d5SpreadAllows(durationSec, state)) return "d5-uniform";
  if (!m4RuntimeAllows(itemId, durationSec, state)) return "m4-runtime";
  return null;
}

/**
 * D2: at most two consecutive segments under `D2_SHORT_SEC`, and then one of at
 * least `D2_RECOVERY_SEC`.
 *
 * SOURCING IS STRICTER THAN THE RULE, ON PURPOSE: it never places a SECOND
 * consecutive short segment, so a run of two never exists and the recovery clause
 * can never come due. The reason is that the checker's rule is about a sequence
 * sourcing has not finished writing. A run of two is legal only if something
 * follows it and that something is 150 s or longer, and at placement time there
 * is no way to know whether another beat will resolve to tape at all — run 2
 * attempt 5 failed on precisely the unrecoverable form, "the Foray ends on two
 * consecutive segments under 60 s … and there is none". Declining to take on a
 * debt this stage cannot promise to pay is a one-line rule with no failure mode;
 * tracking the debt would be a bet on the rest of the Foray.
 */
function d2RunAllows(durationSec: number, state: SourcingState): boolean {
  if (durationSec >= D2_SHORT_SEC) return true;
  const previous = state.placedDurations[state.placedDurations.length - 1];
  return previous === undefined || previous >= D2_SHORT_SEC;
}

/** D3: the running mean of placed durations may not fall under the floor, once
 * there are enough placements for a refusal to move it (`D3_MEAN_MIN_PLACED`). */
function d3MeanAllows(durationSec: number, state: SourcingState): boolean {
  const count = state.placedDurations.length + 1;
  if (count < D3_MEAN_MIN_PLACED) return true;
  const total = state.placedDurations.reduce((a, b) => a + b, 0) + durationSec;
  return total / count >= D3_MEAN_FLOOR_SEC;
}

/**
 * D5, first clause: no three consecutive durations within +/-`D5_TOLERANCE` of
 * each other, pairwise — `max/min <= 1.2`, which is the reading
 * `check-forays.mjs` gates on and the one its own `d5Triples` comment argues for.
 *
 * Asked only against the two most recently placed durations, because that is the
 * only triple this placement can create: every earlier triple was cleared when
 * its own third member was placed. The second clause (the interquartile range) is
 * NOT asked here — see `D5_IQR_FLOOR_SEC`.
 */
function d5SpreadAllows(durationSec: number, state: SourcingState): boolean {
  const placed = state.placedDurations;
  if (placed.length < 2) return true;
  const triple = [placed[placed.length - 2]!, placed[placed.length - 1]!, durationSec];
  const min = Math.min(...triple);
  if (!(min > 0)) return true;
  return Math.max(...triple) / min > 1 + D5_TOLERANCE;
}

/**
 * M4's SECOND clause: no episode over `M4_ITEM_SHARE_MAX` of the Foray's tape
 * SECONDS. #569 gated the count clause and deliberately left this one to
 * `check-forays.mjs`; run 2 attempt 5 then failed on it — one *Practical AI*
 * window at 34.3 % of a 5-segment Foray's runtime — which is F-73.
 *
 * THE SAME SMALL-COUNT EXEMPTION `m4SegmentCapFor` GIVES, AND FOR THE SAME
 * REASON: an episode's FIRST segment is never refused for its length. With one
 * segment an episode's share of the seconds is whatever fraction of a short
 * Foray it happens to be, and #569's argument applies unchanged — refusing an
 * episode's only segment for being long costs the Foray tape without moving any
 * other episode's share, and would make the D-tier ladder above self-defeating
 * (a deliberately long segment would be refused for being long). From an
 * episode's second segment on, the clause is asked in full, which is where
 * genuine over-representation in seconds actually appears.
 *
 * WHAT THIS DOES NOT PROMISE, STATED PLAINLY. A single long segment in a
 * tape-starved Foray can still put its episode over 25 % of the runtime, and
 * nothing at placement time can see that — the share depends on a total this
 * stage has not finished accumulating, and unlike the count clause's
 * `floor(p * 0.25)` a runtime share is not monotone in the safe direction for a
 * candidate judged early. `check-forays.mjs` therefore remains the authority.
 * What closes the gap in practice is the rest of F-73: a mean over 90 s and eight
 * to twelve segments put the 25 % line above `MAX_TAPE_SEGMENT_SEC`, where no
 * single segment can reach it.
 */
function m4RuntimeAllows(itemId: string, durationSec: number, state: SourcingState): boolean {
  const alreadyPlaced = state.usedCountByItem.get(itemId) ?? 0;
  if (alreadyPlaced === 0) return true;
  const episodeSec = (state.placedSecByItem.get(itemId) ?? 0) + durationSec;
  const totalSec = state.placedDurations.reduce((a, b) => a + b, 0) + durationSec;
  if (!(totalSec > 0)) return true;
  return episodeSec / totalSec <= M4_ITEM_SHARE_MAX;
}

/** Writes one tape placement into every Foray-wide ledger. The ONLY place they
 * move, so the two tiers cannot drift apart on what "placed" means — which is
 * exactly how tier 2 came to consult none of them. */
function placeTape(segmentId: string, itemId: string, startSec: number, durationSec: number, state: SourcingState): void {
  state.usedSegmentIds.add(segmentId);
  state.lastStartByItem.set(itemId, startSec);
  state.usedCountByItem.set(itemId, (state.usedCountByItem.get(itemId) ?? 0) + 1);
  state.placedTapeCount += 1;
  state.placedDurations.push(durationSec);
  state.placed.push({ itemId, startSec });
  state.placedSecByItem.set(itemId, (state.placedSecByItem.get(itemId) ?? 0) + durationSec);
}

/* ------------------------------------------------------------------------- */
/* D5's SECOND CLAUSE, ASKED WHERE IT CAN BE ANSWERED (F-73).
 *
 * THE PROBLEM #571 LEFT OPEN, STATED EXACTLY. The interquartile range of a
 * Foray's segment durations is a property of the finished multiset, and it is
 * not monotone in one placement: with three or four segments down, almost any
 * candidate lowers it, so a placement-time refusal declines tape early in order
 * to protect a number that only means anything later — and a Foray with less
 * tape has a worse IQR, not a better one. So `durationVetoFor` gates the triple
 * clause and deliberately does not gate this one, and a run can still reach
 * `check-forays.mjs` and be refused on it ("D5 FAIL: interquartile range 15.6 s
 * is under the 45 s floor").
 *
 * WHAT IS DIFFERENT AFTER THE LAST BEAT. The multiset EXISTS. The question
 * "would this length break the spread" was unanswerable one placement at a
 * time; "which segment, cut differently, would most raise the spread" has an
 * answer, and every rule the change could break can be re-asked against the
 * whole running order rather than guessed at.
 *
 * WHAT THIS PASS IS ALLOWED TO DO, AND WHAT IT IS NOT.
 *   - It re-CUTS at most `D5_RECUT_MAX_SEGMENTS` tier-2 placements, by asking
 *     `cutWindowToSegment` for a different length from `RECUT_TARGETS_SEC`. The
 *     window is untouched, so a re-cut segment is about exactly what it was
 *     about, and growth still only follows the claim's own words
 *     (`growByClaimOverlap`) — a longer cut is never bought with off-claim tape
 *     and a shorter one is a prefix of what the beat already had.
 *   - It NEVER drops tape, never adds any, never changes which beat is sourced
 *     from what, and never touches a tier-1 segment: a pool segment's length is
 *     a curator's decision and not this stage's to revise.
 *   - It refuses any re-cut that would newly break D2, D3, D5's triple clause,
 *     M3 or M4 — each re-asked over the WHOLE sequence, in the form "no worse
 *     than it is now" (`recutKeepsEveryOtherRule`).
 *   - When it cannot reach the floor it says so in one line and leaves every
 *     duration as placed. `check-forays.mjs` stays the authority on the rule;
 *     this is a stage declining to hand it a Foray it can already see refused.
 */

/** How many placements the spread pass may re-cut. Two, because two is what it
 * takes to move both quartiles of a small Foray and because every re-cut is a
 * segment whose length was chosen for a reason at placement time — the ladder
 * target it grew towards. A pass that re-cut everything would be a second
 * length policy competing with `D_TARGET_LADDER_SEC`, not a repair. */
export const D5_RECUT_MAX_SEGMENTS = 2;

/** The lengths a re-cut may ask for: the ladder's own four, plus the shortest
 * and longest a segment may be. The floor and ceiling are what make SHORTENING
 * available at all — the ladder never asks for 45 s, and lowering the bottom
 * quartile is half of what an interquartile range is. */
export const RECUT_TARGETS_SEC: number[] = [...new Set([MIN_TAPE_SEGMENT_SEC, ...D_TARGET_LADDER_SEC, MAX_TAPE_SEGMENT_SEC])].sort(
  (a, b) => a - b
);

/**
 * Interquartile range, R-7 / linear interpolation — NumPy's, R's and Excel's
 * default, and `check-forays.mjs`'s own `iqr`, mirrored here for the reason the
 * constants above it are (that file is an `.mjs` build script Vitest cannot
 * load on every checkout). `check-forays.test.mjs` pins the definition.
 */
export function interquartileRange(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const quantile = (p: number): number => {
    const h = (sorted.length - 1) * p;
    const lo = Math.floor(h);
    const hi = Math.ceil(h);
    return sorted[lo]! + (h - lo) * (sorted[hi]! - sorted[lo]!);
  };
  return quantile(0.75) - quantile(0.25);
}

/** One re-cut the pass is considering: which placement, cut how, and what the
 * Foray's spread would be if it were taken. */
interface SpreadRecut {
  entry: TapeRecut;
  span: TapeSpan;
  durationSec: number;
  spreadSec: number;
}

/** The pass itself — see the block comment above. Mutates the placement ledgers
 * and the very pointer/segment objects the caller is about to return, which is
 * why it runs after every beat is resolved and before nothing at all. */
function liftDurationSpread(state: SourcingState, tapeRelevance: TapeRelevanceInput[]): void {
  /* A SPREAD NEEDS SOMETHING TO SPREAD. With one segment the interquartile
     range is 0 by definition and no cut of any length can move it; with none,
     `check-forays.mjs` never reaches D5 at all ("no resolvable segment items",
     which is F-65 and a different problem). Neither is a case this pass can say
     anything true about, so it says nothing. */
  if (state.placedDurations.length < 2) return;
  if (interquartileRange(state.placedDurations) >= D5_IQR_FLOOR_SEC) return;

  const recut = new Set<number>();
  for (let pass = 0; pass < D5_RECUT_MAX_SEGMENTS; pass++) {
    const best = bestSpreadRecut(state, recut);
    if (!best) break;
    applyRecut(best, state, tapeRelevance);
    recut.add(best.entry.placement);
    if (interquartileRange(state.placedDurations) >= D5_IQR_FLOOR_SEC) return;
  }

  /* ONE LINE, AND THE RUN CONTINUES. The alternative — refusing to finish a
     Foray whose lengths are what the tape allows — would cost every beat's work
     for a rule about variety, and the checker is the authority on whether the
     finished record passes. What this line buys is that nobody has to re-derive
     from a checker error whether sourcing tried. */
  console.warn(
    `sourceBeats: the ${state.placedDurations.length} placed segment${state.placedDurations.length === 1 ? "" : "s"} have an ` +
      `interquartile range of ${interquartileRange(state.placedDurations).toFixed(1)} s, under D5's ${D5_IQR_FLOOR_SEC} s floor, ` +
      `and no re-cut of up to ${D5_RECUT_MAX_SEGMENTS} of them reaches it without breaking D2, D3, D5's triple clause, M3 or M4 ` +
      `(${state.recuts.length} of them are tier-2 cuts this stage may re-cut at all) — leaving every duration as placed; ` +
      "check-forays.mjs is the authority on the rule (F-73)"
  );
}

/**
 * The single re-cut that raises the spread most, or `null` when none does.
 *
 * Deterministic twice over: the placements are walked in placing order and the
 * targets in ascending order, and a tie keeps the candidate found first — so a
 * replay of the same run produces the same cuts, which is the property the
 * whole sourcing stage is built on.
 */
function bestSpreadRecut(state: SourcingState, alreadyRecut: Set<number>): SpreadRecut | null {
  const current = interquartileRange(state.placedDurations);
  let best: SpreadRecut | null = null;

  for (const entry of state.recuts) {
    if (alreadyRecut.has(entry.placement)) continue;
    const placedDuration = state.placedDurations[entry.placement];
    if (placedDuration === undefined) continue;

    for (const targetSec of RECUT_TARGETS_SEC) {
      const span = cutWindowToSegment(entry.claim, entry.cues, entry.window, { targetSec });
      if (!span) continue;
      const durationSec = span.endSec - span.startSec;
      if (durationSec === placedDuration) continue;
      /* A cut may not run past the episode: `merge-segments.mjs` compares a
         minted segment's `reference_duration_sec` against the audio row's own
         `duration_sec`, and `check-forays.mjs` refuses an `end_sec` past it. */
      if (entry.feedDurationSec !== null && span.endSec > entry.feedDurationSec) continue;

      const durations = [...state.placedDurations];
      durations[entry.placement] = durationSec;
      const spreadSec = interquartileRange(durations);
      if (spreadSec <= current) continue;
      if (!recutKeepsEveryOtherRule(entry, span, durations, state)) continue;
      if (!best || spreadSec > best.spreadSec) best = { entry, span, durationSec, spreadSec };
    }
  }
  return best;
}

/**
 * Whether a proposed re-cut leaves every OTHER rule no worse than it is.
 *
 * "No worse than it is" rather than "satisfied", deliberately: a Foray can
 * arrive here already failing a clause the checker will refuse it on — the
 * relaxed pass takes a uniform triple when that is the only tape there is, and
 * a tape-starved Foray's mean can sit under D3's floor with nothing available
 * to lift it. Demanding satisfaction would make this pass inert in exactly
 * those runs; demanding no regression means a re-cut can never be the reason a
 * rule fails, which is the honest guarantee.
 */
function recutKeepsEveryOtherRule(entry: TapeRecut, span: TapeSpan, durations: number[], state: SourcingState): boolean {
  const placed = state.placedDurations;

  /* D2, in the stricter form sourcing keeps at placement time (`d2RunAllows`):
     never two consecutive short segments, because the recovery segment the rule
     would forgive them for cannot be promised. */
  if (shortRunCount(durations) > shortRunCount(placed)) return false;

  /* D5's OWN triple clause. Buying a spread with a uniform triple trades one
     D5 failure for another. */
  if (uniformTripleCount(durations) > uniformTripleCount(placed)) return false;

  /* D3's mean. */
  const mean = meanOf(durations);
  if (mean < D3_MEAN_FLOOR_SEC && mean < meanOf(placed)) return false;

  /* M4's runtime clause, per episode — with `m4RuntimeAllows`'s own exemption
     for an episode that supplies exactly one segment, mirrored here so the two
     halves of this module enforce the same rule. The argument is #569's,
     unchanged: with one segment an episode's share of the seconds is whatever
     fraction of a short Foray it happens to be, nothing this stage does can move
     it (there is no other segment of that episode to shorten), and treating it
     as a veto would freeze the pass solid on precisely the tape-starved Forays
     whose spread most needs lifting. `check-forays.mjs` remains the authority. */
  const counts = placementCountsByItem(state.placed);
  const after = runtimeSharesByItem(durations, state.placed);
  const before = runtimeSharesByItem(placed, state.placed);
  for (const [itemId, share] of after) {
    if ((counts.get(itemId) ?? 0) < 2) continue;
    if (share > M4_ITEM_SHARE_MAX && share > (before.get(itemId) ?? 0)) return false;
  }

  /* And M3: a re-cut can move a segment's START, and segments from one episode
     must play in ascending time order. */
  let lastStart = -Infinity;
  for (let i = 0; i < state.placed.length; i++) {
    const at = state.placed[i]!;
    if (at.itemId !== entry.itemId) continue;
    const startSec = i === entry.placement ? span.startSec : at.startSec;
    if (startSec < lastStart) return false;
    lastStart = startSec;
  }
  return true;
}

/** Adjacent pairs where both segments are short — D2's debt, counted. */
function shortRunCount(durations: number[]): number {
  let runs = 0;
  for (let i = 1; i < durations.length; i++) {
    if (durations[i]! < D2_SHORT_SEC && durations[i - 1]! < D2_SHORT_SEC) runs += 1;
  }
  return runs;
}

/** Consecutive triples within D5's tolerance of each other, pairwise — the
 * reading `check-forays.mjs` gates on (`d5Triples`). */
function uniformTripleCount(durations: number[]): number {
  let hits = 0;
  for (let i = 0; i + 2 < durations.length; i++) {
    const triple = durations.slice(i, i + 3);
    const min = Math.min(...triple);
    if (min > 0 && Math.max(...triple) / min <= 1 + D5_TOLERANCE) hits += 1;
  }
  return hits;
}

function meanOf(durations: number[]): number {
  if (durations.length === 0) return 0;
  return durations.reduce((a, b) => a + b, 0) / durations.length;
}

/** How many segments each episode supplied — M4's small-count exemption. */
function placementCountsByItem(placed: PlacedSegment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const at of placed) counts.set(at.itemId, (counts.get(at.itemId) ?? 0) + 1);
  return counts;
}

/** Each episode's share of the Foray's tape SECONDS, for M4's runtime clause. */
function runtimeSharesByItem(durations: number[], placed: PlacedSegment[]): Map<string, number> {
  const total = durations.reduce((a, b) => a + b, 0);
  const shares = new Map<string, number>();
  if (!(total > 0)) return shares;
  const seconds = new Map<string, number>();
  for (let i = 0; i < placed.length; i++) {
    const itemId = placed[i]!.itemId;
    seconds.set(itemId, (seconds.get(itemId) ?? 0) + (durations[i] ?? 0));
  }
  for (const [itemId, sec] of seconds) shares.set(itemId, sec / total);
  return shares;
}

/**
 * Writes one re-cut everywhere the old cut was written: the minted segment, the
 * beat's pointer, the placement ledgers, and the `tapeRelevance` row that names
 * the segment by id.
 *
 * THE ID IS RE-MINTED WHEN THE START MOVES, because the id is not opaque:
 * `merge-segments.mjs` derives it as `<item_id>#<start_sec rounded>` and would
 * disagree with an id that names a second the segment no longer begins at.
 */
function applyRecut(recut: SpreadRecut, state: SourcingState, tapeRelevance: TapeRelevanceInput[]): void {
  const { entry, span, durationSec } = recut;
  const previousId = entry.pointer.segmentId;
  const previousDuration = state.placedDurations[entry.placement]!;
  const segmentId =
    Math.round(span.startSec) === Math.round(entry.pointer.startSec)
      ? previousId
      : mintSegmentId(entry.itemId, span.startSec, state.mintedIds);

  entry.pointer.segmentId = segmentId;
  entry.pointer.startSec = span.startSec;
  entry.pointer.endSec = span.endSec;
  entry.pointer.startAnchor = span.startAnchor;
  entry.pointer.endAnchor = span.endAnchor;

  entry.segment.id = segmentId;
  entry.segment.startSec = span.startSec;
  entry.segment.endSec = span.endSec;
  entry.segment.startAnchor = span.startAnchor;
  entry.segment.endAnchor = span.endAnchor;
  /* Re-derived exactly as `acceptCandidate` derives it, so a checkout with no
     feed duration keeps the property that the reference covers the segment. */
  entry.segment.referenceDurationSec = entry.feedDurationSec ?? span.endSec;

  state.placedDurations[entry.placement] = durationSec;
  state.placed[entry.placement]!.startSec = span.startSec;
  state.placedSecByItem.set(entry.itemId, (state.placedSecByItem.get(entry.itemId) ?? 0) - previousDuration + durationSec);
  if (segmentId !== previousId) {
    state.usedSegmentIds.delete(previousId);
    state.usedSegmentIds.add(segmentId);
    for (const row of tapeRelevance) {
      if (row.segmentId === previousId) row.segmentId = segmentId;
    }
  }
  /* M3's ledger reads the LAST start placed for an episode, and a re-cut can
     move it. Recomputed from the running order rather than patched, because the
     re-cut placement is not necessarily the episode's last one. */
  let lastStart: number | undefined;
  for (const at of state.placed) if (at.itemId === entry.itemId) lastStart = at.startSec;
  if (lastStart !== undefined) state.lastStartByItem.set(entry.itemId, lastStart);
}

/** What tier 1 saw, once it has decided it has nothing (F-49). Must be called
 * BEFORE any ledger is updated for this beat, or the vetoes it reports would be
 * the beat's own footprint. */
function traceTier1(claim: string, state: SourcingState): Tier1TraceRow {
  const best = scoreSegmentsAgainstClaim(claim, state.segmentPool, { windowText: state.windowText })[0];
  if (!best) {
    return { bestSegmentId: null, bestItemId: null, score: 0, requiredScore: TIER1_MATCH_THRESHOLD, matchedIn: null, gate: "no-candidates" };
  }
  const requiredScore = requiredOverlapFor(best.matchedIn, best.claimTokenCount);
  /* `relaxSpread: true` — reached only after the relaxed pass ALSO found nothing
     (see `resolveOneBeat`), so `d5-uniform` cannot be what stopped this segment
     and reporting it would name a rule that was not enforced (F-73). */
  const gate: Tier1Gate =
    best.score < requiredScore ? "threshold" : (tier1VetoFor(best.segment, state, { relaxSpread: true }) ?? "exhausted");
  return {
    bestSegmentId: best.segment.id,
    bestItemId: best.segment.item_id,
    score: best.score,
    requiredScore,
    matchedIn: best.matchedIn,
    gate
  };
}

/** What tier 2 saw when no episode cleared its threshold: the best on-topic
 * episode and the title-token bar it missed, or — when the topic gate is what
 * emptied the field — the best episode of any family, named as such (F-49). */
function traceTier2Rejected(claim: string, state: SourcingState, isUsable: (entry: TranscriptDigestEntry) => boolean): Tier2TraceRow {
  const onTopic = bestTranscriptArchiveCandidate(claim, state.transcriptArchive, isUsable);
  if (onTopic) return archiveTraceRow(onTopic.entry, onTopic.score, "title-tokens");
  const anyFamily = bestTranscriptArchiveCandidate(claim, state.transcriptArchive);
  if (anyFamily) return archiveTraceRow(anyFamily.entry, anyFamily.score, "lineage");
  return { bestShowId: null, bestEpisodeTitle: null, score: 0, requiredScore: TIER2_MATCH_THRESHOLD, gate: "title-tokens" };
}

function archiveTraceRow(entry: TranscriptDigestEntry, score: number, gate: Tier2TraceRow["gate"]): Tier2TraceRow {
  return { bestShowId: entry.show_id, bestEpisodeTitle: entry.title, score, requiredScore: TIER2_MATCH_THRESHOLD, gate };
}

function resolveOneBeat(beat: Beat, state: SourcingState): BeatResolution {
  const claim = beat.claim;

  /* ARGUMENTS ARE NOT ON TAPE (F-38). A thesis about a class of events —
     "every link in a failure chain gets evaluated against a local question and
     almost never against the global one" — has no episode that is about it, so
     the only thing a word scorer can return for it is a coincidence, and in run
     1 it returned a *Geology Bites* episode on banded iron formations. Skipping
     the lookup outright is the difference between that beat being narrated by
     design and being narrated by luck (under the raised thresholds it would
     have scored 2 and fallen through — right answer, wrong reason). No
     transcription-queue candidate is logged either: nothing to transcribe would
     ever help. */
  if (beat.kind === "argument") {
    return {
      kind: "narration",
      reason: "This beat is an argument, not an account — §4.5 does not look for tape for a claim no recording can be about.",
      diagnosis: { outcome: "skipped:argument", tier1: null, tier2: null }
    };
  }

  // Tier 1: existing data/segments.json pool. Cheapest possible hit,
  // tried first, per §4.5's own search order — no new segment is ever
  // created here.
  /* TWO PASSES, AND THE SECOND DIFFERS BY EXACTLY ONE CLAUSE (F-73). The first
     ranked walk wants a segment that also breaks no uniform triple; if the pool
     has none, the second walk drops that one preference and takes the best
     candidate that clears every hard rule. See `durationVetoFor` for why D5's
     triple clause is the only thing allowed to be relaxed, and why relaxing it is
     better for the finished Foray than losing the tape. */
  const tier1 =
    findTier1Match(claim, state.segmentPool, (segment) => tier1IsUsable(segment, state), { windowText: state.windowText }) ??
    findTier1Match(claim, state.segmentPool, (segment) => tier1IsUsable(segment, state, { relaxSpread: true }), {
      windowText: state.windowText
    });
  if (tier1) {
    placeTape(tier1.segment.id, tier1.segment.item_id, tier1.segment.start_sec, tier1.segment.end_sec - tier1.segment.start_sec, state);
    return {
      kind: "tape",
      /* A pool segment is not the seeded episode's minted window even when it
         comes from the same episode: the seed names a stretch of transcript, and
         what won here is a segment a curator already cut. */
      fromSeed: false,
      nodes: nodesForSegment(tier1.segment, state),
      pointer: {
        segmentId: tier1.segment.id,
        itemId: tier1.segment.item_id,
        startSec: tier1.segment.start_sec,
        endSec: tier1.segment.end_sec,
        startAnchor: tier1.segment.start_anchor,
        endAnchor: tier1.segment.end_anchor,
        tier: 1,
        confidence: tier1.segment.confidence
      }
    };
  }

  /* Tier 1 has nothing. Record what it saw NOW, while the Foray-wide ledgers
     still hold only what earlier beats committed to (F-49). */
  const tier1Trace = traceTier1(claim, state);

  /* TIER 2: THE TRANSCRIPT ARCHIVE, ASKED WHAT IT SAYS (WS-H; F-06, F-49).
     A hit here PRODUCES a new segment via a real, verbatim anchor located in
     the episode's actual cue text — never a raw timestamp, never an invented
     anchor.

     WHAT WS-H CHANGED IS THE CANDIDATE SEARCH, AND ONLY THAT. Until now the
     only way to reach an episode's tape was for its TITLE to share three
     content words with the claim, so run 2's 23 searching beats never got past
     the title bar — *Practical AI*, 63 of 63 bodies present, best title score
     ONE against a claim about ImageNet's label errors (F-49's resolved cause).
     Now the claim's content words are put to an index over the archive's own
     cue text (`textIndex`), the top few episodes are opened, and the gates that
     decide whether the tape is about the claim run on them: the window search
     and its relevance floor (`selectTapeWindow`/`tapeWindowIsRelevant` — F-61's
     replacement for the verbatim-run rule, and F-24's heir), the taxonomy
     lineage gate (F-23/F-29), the cut to whole cues with anchors quoted from
     the tape (`cutWindowToSegment`), and the audio-source check. The title bar
     survives as a fallback candidate and a tie-breaker, never as a gate — which
     is the whole of F-06.

     Candidates are walked in order and the FIRST one that passes every gate
     wins, so a beat still takes at most one tier-2 segment. What the trace
     reports when none passes is the candidate that got FURTHEST, because that
     is the gate a person would go and argue with. */
  const archiveIsUsable = (entry: TranscriptDigestEntry) =>
    familyGateAllows(state.forayTopic, nodesForArchiveEntry(entry, state), state.root);
  const candidates = tier2Candidates(claim, state, archiveIsUsable, beat.seed);

  let furthest: Tier2Progress | null = null;
  /**
   * THE ONE CANDIDATE D5's TRIPLE CLAUSE ALONE STOOD IN THE WAY OF (F-73).
   *
   * `durationVetoFor` treats that clause as a preference rather than a rule — see
   * its own note — so a candidate that clears every hard rule and only makes a
   * uniform triple is remembered here instead of being thrown away, and it is
   * taken after the walk if no better-shaped candidate turned up. The first such
   * candidate is kept, not the best, because the walk is already in preference
   * order: the earlier candidate is the one this beat would have had.
   */
  let spreadDeferred: {
    candidate: Tier2Candidate;
    cues: TranscriptCue[];
    window: TapeWindow;
    span: TapeSpan;
    itemId: string;
    /** F-72's verdict on the deferred candidate's own window, carried so the
     * second chance reports the floor that actually admitted it. */
    seedFloor: "share-only" | undefined;
  } | null = null;

  /**
   * Everything between "this candidate is allowed" and the resolved tape pointer:
   * the audio-source row, the minted segment, the ledgers. Extracted because it
   * has TWO callers now — the walk, and the deferred second chance above — and a
   * second copy of it is a second place for the ledger writes to drift out of
   * step, which is the mistake F-70 was.
   *
   * Returns `null` for exactly one reason, the audio-source refusal, so the
   * caller can record that gate; every other refusal happens before it is called.
   */
  const acceptCandidate = (
    candidate: Tier2Candidate,
    cues: TranscriptCue[],
    window: TapeWindow,
    span: TapeSpan,
    itemId: string,
    seedFloor: "share-only" | undefined
  ): BeatResolution | null => {
    /* TAPE NOTHING CAN PLAY IS NOT TAPE. A minted segment is a pointer into an
       episode's audio, and `check-forays.mjs` refuses a pool item id with no
       `data/segment-sources.json` row ("nothing can resolve its audio"). So the
       row is minted here, from the digest's own enclosure and a real DAI
       verdict, or this candidate is passed over — never a segment id that would
       fail §4.9 four stages later. Inert for a caller that supplied no resolver
       (see `SourceBeatsOptions.audioSourceFor`). */
    const audioSource = state.audioSourceFor ? state.audioSourceFor(candidate.entry, itemId) : null;
    if (state.audioSourceFor && !audioSource) return null;
    if (audioSource) state.newSegmentSources.set(itemId, audioSource);
    const segmentId = mintSegmentId(itemId, span.startSec, state.mintedIds);
    const referenceDurationSec = candidate.entry.feed_duration_sec ?? span.endSec;
    /* `span.startSec`/`span.endSec` are the CUE BOUNDARIES `cutWindowToSegment`
       chose for the window, not a phrase's own few seconds (F-24(c)) — the
       minted segment's times are the tape's own times, and its anchors are the
       tape's own words (F-61). */
    /* THE POOL GATE'S TWO PROVENANCE FIELDS, TAKEN HERE BECAUSE ONLY HERE ARE
       THEY KNOWN (F-78). `why` is the beat's claim, clamped to the pool's
       18-word note (`whyFromClaim`) — the one sentence this pipeline has about
       why this tape was cut. `transcriptSource` is what the cue provider says
       it read: the archive's publisher body unless the provider reports a
       locally transcribed one (`TranscriptCueProvider.transcriptSource`). The
       DAI verdict is deliberately NOT copied onto the segment — it lives on the
       `MintedSegmentSource` row minted just above, and `mintedSegmentRow` reads
       it from there. */
    const segment: NewSegment = {
      id: segmentId,
      itemId,
      startSec: span.startSec,
      endSec: span.endSec,
      referenceDurationSec,
      startAnchor: span.startAnchor,
      endAnchor: span.endAnchor,
      confidence: "medium",
      why: whyFromClaim(claim),
      transcriptSource: state.cueProvider.transcriptSource?.(candidate.entry) ?? "publisher"
    };
    const pointer: TapePointer = {
      segmentId,
      itemId,
      startSec: span.startSec,
      endSec: span.endSec,
      startAnchor: span.startAnchor,
      endAnchor: span.endAnchor,
      tier: 2,
      confidence: "medium"
    };
    state.newSegments.push(segment);
    /* Recorded BEFORE `placeTape`, so `placement` is the index this placement
       is about to take in `placedDurations` (F-73, D5's spread). */
    state.recuts.push({
      claim,
      cues,
      window,
      itemId,
      placement: state.placedDurations.length,
      feedDurationSec: candidate.entry.feed_duration_sec ?? null,
      pointer,
      segment
    });
    placeTape(segmentId, itemId, span.startSec, span.endSec - span.startSec, state);
    return {
      kind: "tape",
      fromSeed: candidate.fromSeed === true,
      seedFloor,
      nodes: nodesForArchiveEntry(candidate.entry, state),
      pointer
    };
  };

  for (const candidate of candidates) {
    const itemId = deriveItemId(candidate.entry);
    /* THE SAME LEDGER TIER 1 KEEPS (F-70). Tier 2 mints its own segment instead
       of picking one out of the pool, and until now that let it walk straight
       past the two Foray-wide assembly rules tier 1 has enforced since the
       pipeline's first end-to-end run — including for the SEEDED candidate the
       walk now puts first, which is how run 2 attempt 4b put two windows of one
       *Practical AI* episode in one slot, backwards.

       Share is asked HERE, before the episode's body is opened, because it
       depends on nothing the search finds — the answer is the same for every
       window of this episode, and refusing early spends no work on tape the
       Foray cannot take. Order is asked further down, on the cut span, because
       that is the first point at which the minted segment has a real start
       time. Both refusals fall through to the next candidate exactly as tier
       1's do: a Foray already full of one episode should take another
       episode's tape, not narration. */
    if (!m4ShareAllows(itemId, state)) {
      furthest = furtherOf(furthest, { candidate, gate: "m4-share" });
      continue;
    }
    const cues = state.cueProvider.getCues(candidate.entry);
    if (!cues) {
      furthest = furtherOf(furthest, { candidate, gate: "no-body" });
      continue;
    }
    /* WHICH WINDOW CARRIES THE BEAT (F-61, and F-24 before it). The relevance
       judgement is made on a STRETCH of tape scored by how much of the claim's
       vocabulary is spoken inside it — not on a verbatim run of the claim's own
       words, which is prose asked to be speech and which run 2 proved does not
       exist (23 of 23 searching beats died on it). A window that clears the
       floor is tape about the claim; run 1's Chernobyl-for-Hyatt anchor and
       F-24's passing mention do not clear it. */
    /* AND THE SEEDED BEAT'S OWN WINDOW IS ASKED FIRST (F-68). WS-L put the
       seeded EPISODE at the front of the walk but then searched the whole hour
       of it, so the stretch §4.3 actually quoted — the one the claim's words
       came out of — competed with every other minute of the same episode and
       lost whenever another minute scored higher. It is asked first now, and
       kept when it clears the floor.

       IT IS A PREFERENCE, NOT A PERMISSION — the same rule as the seeded
       episode itself. When the seed's window does not clear, the whole-episode
       search runs exactly as before and the trace reports what that found. */
    /* AND IT IS THE ONE WINDOW JUDGED ON SHARE ALONE (F-72). The seed window
       was not found by searching — the spine READ it and wrote this claim out
       of it — so the rare-word count, which exists to refuse a window a SEARCH
       landed on for the wrong reason, is reported here but not required. The
       share floor is unchanged and every other window in this loop (the
       whole-episode fallback below, every unseeded beat, every text-index and
       title candidate) faces both conditions exactly as before. The reasoning
       in full, and both floors in one place, are `TapeWindowFloor` in
       `transcriptArchiveLookup.ts`. */
    const seedWindow =
      candidate.fromSeed && beat.seed
        ? selectTapeWindow(claim, cues, {
            idf: candidate.text?.idf,
            within: { startSec: beat.seed.startSec, endSec: beat.seed.endSec }
          })
        : null;
    const seedWindowClears = tapeWindowIsRelevant(seedWindow, "seed-window");
    /* Whether the share-only floor is what let it through, as opposed to a seed
       window that would have cleared the searching floor anyway — the trace
       carries this so a run log can count how often the rule DECIDED. */
    const seedFloor: "share-only" | undefined = seedWindowClears && seedFloorDecided(seedWindow) ? "share-only" : undefined;
    const window = seedWindowClears ? seedWindow : selectTapeWindow(claim, cues, { idf: candidate.text?.idf });
    /* Every window faces the floor for HOW IT WAS FOUND: the seed's own on
       share, anything this search turned up on both conditions. */
    if (!tapeWindowIsRelevant(window, seedWindowClears ? "seed-window" : "archive-search")) {
      furthest = furtherOf(furthest, { candidate, gate: "window-overlap", window });
      continue;
    }
    /* AND WHICH WORDS MARK ITS EDGES (ADR-0007). The anchors are quoted from
       the tape at the window's own boundary cues, so they can be found again in
       a listener's differently-stitched copy; growth to segment length follows
       the claim rather than padding symmetrically (F-62). */
    /* AND HOW LONG A SEGMENT IT IS CUT TO (F-73). The window is chosen for
       relevance and nothing else, which is right; the D-tier rules are about
       LENGTH, and a cut that stopped at `MIN_TAPE_SEGMENT_SEC` left them to
       whatever the window happened to be. The target comes from
       `D_TARGET_LADDER_SEC`, indexed by what this Foray has already placed, so
       consecutive segments are asked for deliberately different lengths — and the
       cut still only grows while the tape is saying the claim's own words, so no
       target is ever bought with off-claim seconds. */
    const span = cutWindowToSegment(claim, cues, window!, { targetSec: tapeTargetFor(state.placedTapeCount) });
    if (!span) {
      furthest = furtherOf(furthest, { candidate, gate: "no-anchor", window, seedFloor });
      continue;
    }
    /* AND THE ORDER RULE, ON THE SPAN'S OWN START (F-70). M3 is about where a
       segment sits in its episode, so it can only be asked once the window has
       been cut to cue boundaries and the minted segment has its real start
       time. Asked BEFORE the audio-source resolution below so a candidate this
       Foray cannot use never writes a `data/segment-sources.json` row for an
       episode no segment ends up coming from. */
    if (!m3OrderAllows(itemId, span.startSec, state)) {
      furthest = furtherOf(furthest, { candidate, gate: "m3-order", window, span, seedFloor });
      continue;
    }
    /* AND THE D-TIER LEDGER, ON THE CUT SPAN'S OWN LENGTH (F-73). Asked here for
       M3's reason exactly: the length is not real until the window has been cut to
       cue boundaries and grown. Asked BEFORE the audio-source resolution below for
       M3's other reason: a candidate this Foray cannot use must not leave a
       `data/segment-sources.json` row behind for an episode no segment comes
       from. */
    const durationVeto = durationVetoFor(itemId, span.endSec - span.startSec, state);
    if (durationVeto) {
      furthest = furtherOf(furthest, { candidate, gate: durationVeto, window, span, seedFloor });
      /* D5's triple clause is a preference, so the candidate it ALONE refused is
         kept for the second chance below. Re-asked with the clause dropped, which
         is what proves "alone": `m4-runtime` is asked after it and would otherwise
         never have been asked at all. `seedFloor` travels with it, or the second
         chance would credit the searching floor for a window F-72's admitted. */
      if (
        durationVeto === "d5-uniform" &&
        !spreadDeferred &&
        durationVetoFor(itemId, span.endSec - span.startSec, state, { relaxSpread: true }) === null
      ) {
        spreadDeferred = { candidate, cues, window: window!, span, itemId, seedFloor };
      }
      continue;
    }
    const accepted = acceptCandidate(candidate, cues, window!, span, itemId, seedFloor);
    if (accepted) return accepted;
    furthest = furtherOf(furthest, { candidate, gate: "no-audio-source", window, span, seedFloor });
  }

  /* THE SECOND CHANCE, ONE CLAUSE LIGHTER (F-73). Nothing in the archive could be
     cut for this beat WITHOUT making a uniform triple — so the choice is between a
     Foray that sounds a little metronomic here and a Foray with one less piece of
     tape, and `durationVetoFor` explains at length why the tape wins. The trace
     still records what happened: `furthest` holds the `d5-uniform` row, so a run's
     log says which beats took this branch. */
  if (spreadDeferred) {
    const accepted = acceptCandidate(
      spreadDeferred.candidate,
      spreadDeferred.cues,
      spreadDeferred.window,
      spreadDeferred.span,
      spreadDeferred.itemId,
      spreadDeferred.seedFloor
    );
    if (accepted) return accepted;
    furthest = furtherOf(furthest, {
      candidate: spreadDeferred.candidate,
      gate: "no-audio-source",
      window: spreadDeferred.window,
      span: spreadDeferred.span,
      seedFloor: spreadDeferred.seedFloor
    });
  }

  const tier2Trace = tier2TraceFor(claim, state, archiveIsUsable, candidates, furthest, beat.seed);

  /* Tier 3: nothing in the archive could be cut for this beat. Log ONE
     transcription-queue candidate saying how far the search got — this
     pipeline's OWN log, distinct from and never written into
     `data/transcription-queue.json`, which has its own producer
     (`tools/transcribe/build-transcription-queue.mjs`) — and let the beat
     become narration. */
  state.transcriptionQueueCandidates.push(transcriptionQueueRow(claim, furthest));

  return {
    kind: "narration",
    reason: narrationReasonFor(furthest),
    diagnosis: { outcome: "no-tape", tier1: tier1Trace, tier2: tier2Trace }
  };
}

/** One episode tier 2 is willing to open for a claim, and how it was found. */
interface Tier2Candidate {
  entry: TranscriptDigestEntry;
  /** The title-metadata score — now a tie-breaker and a trace field, not a bar. */
  titleScore: number;
  /** The text-index row that produced it, or `null` for the title fallback. */
  text: TranscriptTextCandidate | null;
  /** This is the episode §4.3 wrote the beat's claim from (WS-L, F-63). */
  fromSeed?: boolean;
}

/** How far one candidate got, for the trace. */
interface Tier2Progress {
  candidate: Tier2Candidate;
  gate: Tier2Gate;
  /** The best window this candidate's tape had for the claim — present from the
   * window search onwards, `null` only when the episode had no usable cues. */
  window?: TapeWindow | null;
  /** The cut span, when the search got as far as minting anchors from it. */
  span?: TapeSpan;
  /** Set when the reported window is a seed window the share-only floor
   * admitted (F-72) — a beat refused at a LATER gate still says which floor let
   * its window through, or the trace would credit the searching floor. */
  seedFloor?: "share-only";
}

/**
 * How much progress each gate represents. A beat that reached the window test
 * on one episode and a bare title on seven others is a beat whose story is the
 * window test — reporting the last candidate walked, or the highest-ranked one,
 * would hide the only row worth reading (F-49).
 */
const TIER2_GATE_PROGRESS: Record<Tier2Gate, number> = {
  "text-index:no-candidate": 0,
  lineage: 1,
  "title-tokens": 2,
  /* F-70's two assembly gates sit where the walk actually asks them: `m4-share`
     before the body is opened, `m3-order` after the span is cut. Ordering them
     by where they are asked keeps this table a description of the loop rather
     than a second opinion about it. */
  "m4-share": 3,
  "no-body": 4,
  /* `window-overlap` now comes FIRST of the two tape gates and `no-anchor`
     after it, because F-61 swapped their order: relevance is decided on the
     window, and only a window that passed is asked for anchors. A beat that
     reached `no-anchor` therefore got further than one that did not. */
  "window-overlap": 5,
  "no-anchor": 6,
  "m3-order": 7,
  /* F-73's four length gates sit where the walk asks them too: after the span is
     cut (so its duration is real) and before the audio-source row is written. A
     beat that reached one of these got further than one refused on M3, because
     M3 is answered first, on the same span. */
  "d2-short-run": 8,
  "d3-mean": 9,
  "d5-uniform": 10,
  "m4-runtime": 11,
  "no-audio-source": 12
};

function furtherOf(current: Tier2Progress | null, next: Tier2Progress): Tier2Progress {
  if (!current) return next;
  return TIER2_GATE_PROGRESS[next.gate] > TIER2_GATE_PROGRESS[current.gate] ? next : current;
}

/**
 * The episodes tier 2 will open, best first: the text index's top N, then the
 * title-metadata match if it is not already among them.
 *
 * THE TITLE MATCH IS STILL HERE, LAST. It is what tier 2 ran on before WS-H and
 * it is what a checkout without transcript bodies (`NullTranscriptTextIndex`,
 * every CI run) has: keeping it means this change can only ADD candidates, so
 * no beat that found tape before can stop finding it. Its score is carried on
 * every candidate as the tie-breaker `transcriptTextIndex` ranks equal-text
 * episodes by.
 */
function tier2Candidates(
  claim: string,
  state: SourcingState,
  isUsable: (entry: TranscriptDigestEntry) => boolean,
  seed: BeatSeed | undefined
): Tier2Candidate[] {
  const claimTokens = new Set(tokenizeForSourcing(claim));
  const candidates: Tier2Candidate[] = [];
  const seen = new Set<string>();
  const key = (entry: TranscriptDigestEntry) => `${entry.show_id}\u0000${entry.guid}`;

  for (const hit of state.textIndex.search(claim, { limit: TRANSCRIPT_TEXT_CANDIDATES, isUsable })) {
    if (seen.has(key(hit.entry))) continue;
    seen.add(key(hit.entry));
    candidates.push({ entry: hit.entry, titleScore: titleTokenScore(claimTokens, hit.entry), text: hit });
  }

  const byTitle = findTranscriptArchiveMatch(claim, state.transcriptArchive, isUsable);
  if (byTitle && !seen.has(key(byTitle.entry))) {
    candidates.push({ entry: byTitle.entry, titleScore: byTitle.score, text: null });
  }
  return seededFirst(candidates, claimTokens, state, isUsable, seed);
}

/**
 * THE SEEDED EPISODE IS OPENED FIRST (fix plan WS-L; finding F-63).
 *
 * When §4.3 wrote a beat FROM a stretch of tape, the episode it was written from
 * is the best-informed guess in this pipeline about where that beat's tape is —
 * better than a BM25 ranking of the claim's words, because the claim's words
 * came out of that episode's mouth. So it goes to the front of the walk.
 *
 * ORDER IS ALL IT CHANGES. The seeded candidate then faces the same window
 * search, the same relevance floor, the same lineage gate, the same anchor mint
 * and the same audio-source check as any other, and the walk continues past it
 * when it fails one — a seed is a hint, never a permission. Nothing here lowers
 * a threshold, and a seeded episode the topic gate refuses (`isUsable`) is never
 * added at all. (The seed's own SECONDS are used one step later, in the tier-2
 * walk, where its window is the first one the episode is asked for — F-68.)
 *
 * WHEN THE SEEDED EPISODE IS ALSO IN THE TEXT RESULTS it is MOVED rather than
 * re-added, so it keeps the `idf` weights that search computed — the window
 * search is measurably better with them (F-61's weighted share). When it is not,
 * it is prepended without them, which is exactly the title-path candidate's
 * situation and weighs every term one.
 */
function seededFirst(
  candidates: Tier2Candidate[],
  claimTokens: Set<string>,
  state: SourcingState,
  isUsable: (entry: TranscriptDigestEntry) => boolean,
  seed: BeatSeed | undefined
): Tier2Candidate[] {
  if (!seed) return candidates;
  const existing = candidates.findIndex((c) => entryMatchesSeed(c.entry, seed));
  if (existing >= 0) {
    const [found] = candidates.splice(existing, 1);
    return [{ ...found!, fromSeed: true }, ...candidates];
  }
  const entry = state.transcriptArchive.find((e) => entryMatchesSeed(e, seed) && isUsable(e));
  if (!entry) return candidates;
  return [{ entry, titleScore: titleTokenScore(claimTokens, entry), text: null, fromSeed: true }, ...candidates];
}

/** The seed names an episode by `deriveItemId` — what §4.2's research window
 * carried — and a guid is accepted too, because that is the archive's own key
 * and a hand-written seed is likelier to use it than to re-derive a slug. */
function entryMatchesSeed(entry: TranscriptDigestEntry, seed: BeatSeed): boolean {
  return deriveItemId(entry) === seed.episodeId || entry.guid === seed.episodeId;
}

/** The row that says what tier 2 saw and which gate decided (F-49). */
function tier2TraceFor(
  claim: string,
  state: SourcingState,
  isUsable: (entry: TranscriptDigestEntry) => boolean,
  candidates: Tier2Candidate[],
  furthest: Tier2Progress | null,
  seed: BeatSeed | undefined
): Tier2TraceRow {
  /* WS-L: a seeded beat that ended up narrated is the case worth reading — the
     spine wrote a claim from this episode and the tape there would not carry it.
     Stamped on every branch below, including the ones that never opened an
     episode at all. */
  const withSeed = (row: Tier2TraceRow): Tier2TraceRow =>
    seed ? { ...row, seededEpisode: seed.episodeId, seedWindowWon: false } : row;
  if (!furthest) {
    /* Nothing was even worth opening. When the text index ran, that IS the
       deciding gate; when the topic gate is what emptied the field, `lineage`
       is the more specific answer and keeps precedence; and when no index ran
       at all (CI, and every caller that predates WS-H) the answer is the
       title-token bar, exactly as before. */
    const rejected = traceTier2Rejected(claim, state, isUsable);
    if (state.textIndex.enabled && rejected.gate === "title-tokens") {
      return withSeed({ ...rejected, gate: "text-index:no-candidate", candidatesConsidered: 0 });
    }
    return withSeed(rejected);
  }
  const { candidate, gate, window, span, seedFloor } = furthest;
  const row: Tier2TraceRow = {
    ...archiveTraceRow(candidate.entry, candidate.titleScore, gate),
    candidatesConsidered: candidates.length,
    foundBy: candidate.text ? "text-index" : "title"
  };
  if (candidate.text) {
    row.textScore = Number(candidate.text.score.toFixed(3));
    row.textRank = candidate.text.rank;
    row.textMatchedTerms = candidate.text.matchedTerms;
  }
  /* WHICH CLAIM WORDS THE TAPE ACTUALLY SAID, AND WHERE (F-61). A share and a
     count can be argued with; "no anchor" could not. */
  if (window) {
    row.windowMatchedTerms = window.matchedTerms;
    row.windowDistinctiveTerms = window.distinctiveTerms;
    row.windowTermShare = Number(window.share.toFixed(3));
    row.windowWeightedShare = Number(window.weightedShare.toFixed(3));
    row.windowStartSec = window.startSec;
    row.windowEndSec = window.endSec;
  }
  /* And, when the search got far enough to quote the tape, the anchors it
     minted — the thing a person spot-checking a run reads first. */
  if (span) {
    row.startAnchor = span.startAnchor;
    row.endAnchor = span.endAnchor;
  }
  /* F-72: which floor judged the reported window. Only ever set on a seed
     window the share-only floor admitted — a `window-overlap` row never carries
     it, because a refused window was admitted by no floor at all. */
  if (seedFloor) row.seedFloor = seedFloor;
  return withSeed(row);
}

/** The narration reason a beat carries into §4.7, keyed to how far tier 2 got. */
function narrationReasonFor(furthest: Tier2Progress | null): string {
  switch (furthest?.gate) {
    /* F-70: these two say the tape exists and this FORAY cannot take it, which
       is a different thing from the archive having nothing — and the narration
       reason travels into §4.7, where a writer reading "no tape found" for a
       beat whose episode is already in the Foray twice would be reading a
       falsehood. */
    case "m4-share":
      return "Tape for this beat is in an episode this Foray already draws a quarter of its segments from, so taking more would unbalance it.";
    case "m3-order":
      return "Tape for this beat was found earlier in an episode this Foray has already joined later, so playing it here would run the episode backwards.";
    /* F-73: the same kind of statement as the two above — the tape exists and is
       about the claim, and this Foray's own running order is what refused it. A
       §4.7 writer reading "no tape found" for a beat whose tape was the wrong
       LENGTH would be reading a falsehood. */
    case "d2-short-run":
      return "Tape for this beat was found, but it is short and the segment before it is short too, and the running order does not allow a run of short segments here.";
    case "d3-mean":
      return "Tape for this beat was found, but it is short enough that taking it would pull this Foray's mean segment length under the floor the running-order rules set.";
    case "d5-uniform":
      return "Tape for this beat was found, but it is nearly the same length as the two segments before it, and three segments of one length would make the Foray sound metronomic.";
    case "m4-runtime":
      return "Tape for this beat is in an episode that already supplies a quarter of this Foray's tape seconds, so taking more would unbalance it.";
    case "no-audio-source":
      return "Tape was found for this beat but its episode's audio cannot be resolved, so it cannot be played.";
    case "window-overlap":
      return "The tape was searched for this claim and no stretch of it is about the claim.";
    case "no-anchor":
      return "A stretch of tape about this claim was found, but its edges yield no phrase that could anchor a boundary.";
    default:
      return "No tape found anywhere in the §4.5 search order for this beat.";
  }
}

/** Which of this Foray's own assembly rules refused a usable piece of tape, in
 * the words the transcription-queue row uses. One phrase per gate, so a row can
 * name the rule without the caller re-deriving it from the gate name. */
const ASSEMBLY_REFUSAL_CLAUSE: Record<"m4-share" | "m3-order" | DurationGate, string> = {
  "m4-share": "the episode already supplies its quarter of the segments",
  "m3-order": "the window sits earlier in an episode already joined later",
  "d2-short-run": "it is short and the segment before it is short too",
  "d3-mean": "taking it would pull the Foray's mean segment length under the floor",
  "d5-uniform": "it is within a fifth of the length of each of the two segments before it",
  "m4-runtime": "the episode already supplies its quarter of the tape seconds"
};

/** One queue row per narrated beat, naming the episode the search got furthest
 * into and what stopped it there. */
function transcriptionQueueRow(claim: string, furthest: Tier2Progress | null): TranscriptionQueueCandidate {
  if (!furthest) {
    return {
      claim,
      reason: "No hit in data/segments.json or the transcript archive; logged for future transcription/extraction, not acted on here."
    };
  }
  const { candidate, gate, window } = furthest;
  const found = candidate.text ? "Transcript text matched" : "Transcript-archive metadata matched";
  switch (gate) {
    /* F-70: NOT a transcription gap. Nothing about transcribing more tape would
       change either answer — the archive already had what this beat needed and
       the Foray's own assembly rules refused it — so the row says so plainly
       rather than implying work that would not help. F-73's four length rules are
       the same kind of refusal and join the same row. */
    case "m4-share":
    case "m3-order":
    case "d2-short-run":
    case "d3-mean":
    case "d5-uniform":
    case "m4-runtime":
      return {
        claim,
        showId: candidate.entry.show_id,
        reason: `${found} ("${candidate.entry.title}") and the tape is usable, but this Foray's own assembly rules refused it (${ASSEMBLY_REFUSAL_CLAUSE[gate]}). Nothing to transcribe.`
      };
    case "no-audio-source":
      return {
        claim,
        showId: candidate.entry.show_id,
        reason: `Transcript-archive tape was located in "${candidate.entry.title}", but no data/segment-sources.json row can be written for it (no resolvable https audio URL, feed duration, or DAI verdict), so nothing could play it.`
      };
    case "window-overlap":
      return {
        claim,
        showId: candidate.entry.show_id,
        reason: `${found} ("${candidate.entry.title}") but its best window of tape speaks ${window?.matchedTerms.length ?? 0} of the claim's ${window?.claimTermCount ?? 0} content words, ${window?.distinctiveTerms.length ?? 0} of them rare (${Math.round((window?.weightedShare ?? 0) * 100)} % of the claim, weighted by rarity) — below the ${TIER2_WINDOW_MIN_TERMS} rare words and ${Math.round(TIER2_WINDOW_MIN_SHARE * 100)} % needed to call the tape there on topic.`
      };
    case "no-anchor":
      return {
        claim,
        showId: candidate.entry.show_id,
        reason: `${found} ("${candidate.entry.title}") and a window of its tape is about the claim, but neither boundary cue yields a quotable phrase, so no anchor could be minted.`
      };
    default:
      return {
        claim,
        showId: candidate.entry.show_id,
        reason: `${found} ("${candidate.entry.title}") but no cue text was available to locate a verbatim anchor.`
      };
  }
}

/**
 * Every taxonomy node a POOL SEGMENT can be said to belong to: its own `topic`
 * plus its show's `taxonomy_node_ids`.
 *
 * The union — rather than the segment's `topic` alone — is deliberate, and it
 * is the same union WS-B's `computeTapeRelevance` builds from disk. Two reasons
 * it has to be a union. A segment's own node is the more specific signal but 67
 * of the 212 pooled segments have no resolvable show, and 16 of the 145 that do
 * disagree with it: the three Hyatt Regency segments carry
 * `architecture/infrastructure`, `engineering/disasters` and `engineering`
 * between them, all cut from one episode of one show the catalogue classifies
 * as `engineering/disasters`. Gating on the segment's own node alone would
 * refuse the first of those three for an engineering Foray — the right episode,
 * refused on a curator's per-segment nuance. And computing it differently from
 * WS-B would let the gate and the metric that scores the gate disagree about
 * the same anchor, which is exactly the kind of silent divergence run 1 was
 * made of.
 */
function nodesForSegment(segment: SegmentRecord, state: SourcingState): string[] {
  return unionNodes(segment.topic ?? null, taxonomyNodesForItemId(segment.item_id, state.root));
}

/** The same, for a tier-2 archive episode: its show's nodes by `show_id`, plus
 * the item-id join so a minted segment resolves the way a pooled one does. */
function nodesForArchiveEntry(entry: TranscriptDigestEntry, state: SourcingState): string[] {
  return unionNodes(taxonomyNodesForShowId(entry.show_id, state.root), taxonomyNodesForItemId(deriveItemId(entry), state.root));
}

/**
 * Joins a pool segment to the transcript body of the episode it was cut from,
 * so tier 1 can score a claim against the words actually spoken inside the
 * segment (F-06 / F-29).
 *
 * The join is `data/segments.json`'s `item_id` against the id `deriveItemId`
 * mints from a digest entry — the same `<show_id>--<title-slug>` shape both
 * sides already use (`causality-engineered-network--47-hyatt-regency-kansas-city`).
 * Everything is cached: a Foray asks about the same segments once per beat, and
 * the cue provider itself caches file reads.
 *
 * NOTE: no path in here reads `data-local/` — the only thing that can reach a
 * transcript body is the injected `TranscriptCueProvider`, which is the same
 * rule the module doc comment states and `sourceBeats.noFetch.test.ts` checks.
 */
function makeSegmentWindowText(archive: TranscriptDigestEntry[], cueProvider: TranscriptCueProvider): SegmentWindowText {
  let byItemId: Map<string, TranscriptDigestEntry> | null = null;
  const cache = new Map<string, string | null>();
  return (segment: SegmentRecord) => {
    if (cache.has(segment.id)) return cache.get(segment.id) ?? null;
    if (!byItemId) {
      byItemId = new Map();
      for (const entry of archive) {
        const id = deriveItemId(entry);
        if (!byItemId.has(id)) byItemId.set(id, entry);
      }
    }
    let text: string | null = null;
    const entry = byItemId.get(segment.item_id);
    if (entry) {
      const cues = cueProvider.getCues(entry);
      if (cues) {
        const window = cueWindowText(cues, segment.start_sec, segment.end_sec).trim();
        text = window.length > 0 ? window : null;
      }
    }
    cache.set(segment.id, text);
    return text;
  };
}

/* `deriveItemId` moved to `transcriptArchiveLookup.ts` with WS-L \u2014 it derives an
   id from a digest row and now has callers two stages earlier (\u00a74.2's research
   windows name their episode with it, \u00a74.3's beat seed carries that name back).
   Re-exported here, unchanged, so every existing importer is untouched. */
export { deriveItemId };

/** Same id shape as `data/segments.json`'s existing rows
 * (`<item_id>#<start_sec rounded>`), with a numeric suffix to resolve a
 * collision — mirrors `mintItemIds`'s collision-resolution rule. */
function mintSegmentId(itemId: string, startSec: number, existing: Set<string>): string {
  const base = `${itemId}#${Math.round(startSec)}`;
  let id = base;
  let n = 2;
  while (existing.has(id)) id = `${base}-${n++}`;
  existing.add(id);
  return id;
}
