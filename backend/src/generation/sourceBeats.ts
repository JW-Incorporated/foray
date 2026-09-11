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
  nodesForArchiveEntry,
  nodesForPoolSegment,
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
    `check-forays.mjs` gates on — see its own `d5Triples` note on why. The
    arithmetic itself lives in `d5Triple.ts` (F-80), mirrored from the checker
    and pinned to it by `test/d5Triple.test.ts`; re-exported here so every
    importer of this module's constants keeps working. */
export { D5_TOLERANCE } from "./d5Triple";
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
  segmentAtStart,
  startsCoincide,
  tier1BarClears,
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
import { d5DistanceFromPrevious, d5Triples, placementEscapesD5Triple } from "./d5Triple";

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
            seedFloor: resolution.seedFloor,
            /* F-80: and whether D5's triple clause is what chose this segment's
               LENGTH — the ladder rung's own cut would have made a uniform
               triple, and a different cut of the same window escaped it. */
            lengthGate: resolution.lengthGate,
            /* F-84: and whether the tape is the pool's own cut at the start
               tier 2's window reached — reused, never minted beside. */
            poolCut: resolution.poolCut
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
   * anyway, so counting it counts decisions rather than applications.
   * `lengthGate` — D5's triple clause chose this cut's LENGTH (F-80): the
   * ladder rung's own cut would have been a uniform triple; absent whenever the
   * rung's cut escaped the band by itself, for the same counting reason.
   * `poolCut` — tier 2's window began where a committed pool segment begins and
   * the pool's cut was placed under its own id instead of a minted sibling
   * (F-84). */
  | {
      kind: "tape";
      pointer: TapePointer;
      nodes: string[];
      fromSeed: boolean;
      seedFloor?: "share-only";
      lengthGate?: "d5-triple";
      poolCut?: "reused";
    }
  | { kind: "narration"; reason: string; diagnosis: SourcingDiagnosis };

/**
 * Whether a pool segment may be used, and if not, WHICH rule refused it.
 *
 * Extracted from `findTier1Match`'s inline predicate so the trace can name the
 * gate that stopped the best candidate instead of reporting a bare "no match"
 * (F-49). The check order is unchanged, and `tier1IsUsable` below is the same
 * predicate the search has always been given — a boolean view of this one.
 */
function tier1VetoFor(segment: SegmentRecord, state: SourcingState): Exclude<Tier1Gate, "no-candidates" | "threshold"> | null {
  /* THE TOPIC GATE (F-29). The pool has always carried a `topic` node per
     segment and the Foray has always had one; nothing compared them, which is
     how a Kansas City walkway beat took a British hearth-cooking segment.
     Checked inside the ranked walk, like the assembly rules below, so the
     search falls through to the next ON-TOPIC candidate instead of giving up. */
  if (!familyGateAllows(state.forayTopic, nodesForPoolSegment(segment, state.root), state.root)) return "topic-lineage";
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
     identity. (`d5-triple` included, since F-80: a curated segment that would
     make a uniform triple is passed over for the next candidate, and then for
     tier 2, whose cut CAN change length — see `durationVetoFor`.) */
  return durationVetoFor(segment.item_id, segment.end_sec - segment.start_sec, state);
}

function tier1IsUsable(segment: SegmentRecord, state: SourcingState): boolean {
  return tier1VetoFor(segment, state) === null;
}

/**
 * The segment that ALREADY begins where a cut of `itemId` at `startSec` would
 * (F-84): a committed `data/segments.json` row, or one this run minted for an
 * earlier beat. `null` when the start is free. The run's own mints are in here
 * so two beats cutting the same start of one episode resolve to one id — the
 * second is then refused as already played, which is what `usedSegmentIds` has
 * always said about a segment, rather than minted as `…-2`.
 */
function committedCutAt(itemId: string, startSec: number, state: SourcingState): SegmentRecord | null {
  const pool = segmentAtStart(state.segmentPool, itemId, startSec);
  if (pool) return pool;
  const mine = state.newSegments.find((s) => s.itemId === itemId && startsCoincide(s.startSec, startSec));
  if (!mine) return null;
  return {
    id: mine.id,
    item_id: mine.itemId,
    topic: state.forayTopic ?? "",
    start_sec: mine.startSec,
    end_sec: mine.endSec,
    reference_duration_sec: mine.referenceDurationSec,
    start_anchor: mine.startAnchor,
    end_anchor: mine.endAnchor,
    why: mine.why,
    confidence: mine.confidence,
    transcript_source: mine.transcriptSource
  };
}

/** The ledger a reused pool cut faces (F-84) — every rule `tier1VetoFor` asks
 * except the topic lineage, which the archive episode this window came from
 * has already passed (`archiveIsUsable`): the tape is the same tape whichever
 * row names it. */
function reuseVetoFor(segment: SegmentRecord, state: SourcingState): Exclude<Tier1Gate, "no-candidates" | "threshold" | "topic-lineage"> | null {
  if (state.usedSegmentIds.has(segment.id)) return "exhausted";
  if (!m4ShareAllows(segment.item_id, state)) return "m4-share";
  if (!m3OrderAllows(segment.item_id, segment.start_sec, state)) return "m3-order";
  return durationVetoFor(segment.item_id, segment.end_sec - segment.start_sec, state);
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
   checker (D3, D5's triple clause, M4's runtime clause) or deliberately STRICTER
   in the one direction sourcing cannot see (D2) — never looser. Where sourcing
   is stricter the comment says so and says why. */

/** Which D-tier rule a candidate duration would break, or `null`. */
type DurationGate = "d2-short-run" | "d3-mean" | "d5-triple" | "m4-runtime";

/**
 * ALL FOUR ARE HARD. Each refuses tape whose LENGTH does damage no later
 * placement can undo: a second consecutive short segment starts a run D2 will
 * not forgive, a short segment below the running mean pulls D3's average down
 * for good, a third segment inside +/-20 % of the two before it is a uniform
 * triple no later cut can un-make, and an episode past its quarter of the
 * seconds is past it. Declining any of them costs the candidate — and, when no
 * other candidate clears them, the beat its tape — and that is the right trade:
 * the checker's verdict on any of them is fatal to the whole run.
 *
 * D5's TRIPLE CLAUSE WAS A PREFERENCE UNTIL F-80, AND HERE IS WHY IT NO LONGER
 * IS. #571 argued that refusing every candidate that resembles its two
 * predecessors could starve a Foray of tape, so it remembered the one candidate
 * the clause alone refused and took it when nothing better turned up. Run 5
 * (2026-09-11) is what that costs: a 25-segment Foray, narrated end to end, was
 * refused at finalize on `practical-ai--tiny-recursive-networks#603 /
 * …model-context-protocol-deep-dive#2297 / …federated-learning-in-production-part-1#1650`
 * at 152.0 / 142.2 / 169.4 s (max/min 1.191) — one relaxed placement, and every
 * page of narration written after it was for a Foray nothing could publish.
 * #620 keeps the clause strict on the partial candidate as well, so under G-30
 * the same placement now ends the run after act 1. The starvation argument was
 * about a POOL of fixed lengths; tier 2 cuts its own segment from a window and
 * can choose a length, which is what `chooseCutForPlacement` now does — the
 * clause costs a beat its tape only when no candidate's window can be cut
 * outside the band at all. A pool segment that would make the triple is passed
 * over for the next one, and then for tier 2, exactly as `m3-order` is.
 *
 * Nothing in this file relaxes any of the four.
 */
function durationVetoFor(itemId: string, durationSec: number, state: SourcingState): DurationGate | null {
  if (!d2RunAllows(durationSec, state)) return "d2-short-run";
  if (!d3MeanAllows(durationSec, state)) return "d3-mean";
  if (!placementEscapesD5Triple(state.placedDurations, durationSec)) return "d5-triple";
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

/* D5's first clause is `placementEscapesD5Triple` in `d5Triple.ts` (F-80): the
   checker's own arithmetic, asked against the two most recently placed durations
   because that is the only triple this placement can create. The second clause
   (the interquartile range) is NOT asked here — see `D5_IQR_FLOOR_SEC`. */

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
         `duration_sec`, and `check-forays.mjs` refuses an `end_sec` past it.
         The same rule the placement itself faces (`pastDurationGate`, F-87). */
      if (pastDurationGate(span, entry.feedDurationSec) !== null) continue;
      /* And a re-cut may not MOVE onto a start another segment already holds
         (F-84): the id is the start, and `applyRecut` re-mints it when the start
         moves, so a start the pool or this run already has a row at would be a
         sibling id. The placement's own start is not a collision with itself. */
      if (recutStartIsTaken(entry, span, state)) continue;

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

/** Whether a re-cut's start would take an id the pool or this run already
 * holds (F-84) — asked only when the start moves to a different rounded
 * second, since `applyRecut` keeps the id otherwise; the placement's own row is
 * not a collision with itself. */
function recutStartIsTaken(entry: TapeRecut, span: TapeSpan, state: SourcingState): boolean {
  if (Math.round(span.startSec) === Math.round(entry.pointer.startSec)) return false;
  if (state.mintedIds.has(`${entry.itemId}#${Math.round(span.startSec)}`)) return true;
  const held = committedCutAt(entry.itemId, span.startSec, state);
  return held !== null && held.id !== entry.pointer.segmentId;
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
 * reading `check-forays.mjs` gates on, by the mirrored helper (`d5Triple.ts`). */
function uniformTripleCount(durations: number[]): number {
  return d5Triples(durations).length;
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
function traceTier1(claim: string, state: SourcingState, idf: ReadonlyMap<string, number> | undefined): Tier1TraceRow {
  const best = scoreSegmentsAgainstClaim(claim, state.segmentPool, { windowText: state.windowText, idf })[0];
  if (!best) {
    return { bestSegmentId: null, bestItemId: null, score: 0, requiredScore: TIER1_MATCH_THRESHOLD, matchedIn: null, gate: "no-candidates" };
  }
  const requiredScore = requiredOverlapFor(best.matchedIn, best.claimTokenCount);
  /* `threshold` covers both the count bar and, for a transcript window, the
     weighted floor (G-24 R2); the two window fields below say which. Every
     other gate is the one `tier1VetoFor` actually enforced on the ranked walk —
     `d5-triple` included, since F-80 made it a rule rather than a preference. */
  const gate: Tier1Gate = !tier1BarClears(best) ? "threshold" : (tier1VetoFor(best.segment, state) ?? "exhausted");
  const row: Tier1TraceRow = {
    bestSegmentId: best.segment.id,
    bestItemId: best.segment.item_id,
    score: best.score,
    requiredScore,
    matchedIn: best.matchedIn,
    gate
  };
  if (best.matchedIn === "transcript") {
    row.windowWeightedShare = Number(best.weightedShare.toFixed(3));
    row.windowDistinctiveTerms = best.distinctiveTerms;
  }
  return row;
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

  /* TIER 2'S CANDIDATES ARE GATHERED BEFORE TIER 1 RUNS (G-24 R2), because one
     of them is asked first. Gathering is a text-index query and a title scan —
     no body is opened here. */
  const archiveIsUsable = (entry: TranscriptDigestEntry) =>
    familyGateAllows(state.forayTopic, nodesForArchiveEntry(entry, state.root), state.root);
  const candidates = tier2Candidates(claim, state, archiveIsUsable, beat.seed);
  const walk = new Tier2Walk(beat, candidates, state);

  /* THE SEED WINDOW IS ASKED BEFORE TIER 1 (G-24 R2; tape-yield brief §4 cause
     4). §4.5's search order puts the pool first because a curated segment is the
     cheapest hit — and for an UNSEEDED beat it still is. A seeded beat is
     different: the spine READ a stretch of tape and wrote the claim out of it,
     so the best-informed guess in this pipeline about where the beat's tape is
     has already been made, and tier 1's coverage bar — a quarter of the claim's
     words, unweighted, in a segment somebody cut for another reason — is a
     weaker judgement than the seed's. On attempt 6 it was the wrong one: beat
     2/0/0's seed window (durable-agents 1769-1911, "what if the tool calls time
     out? what if I don't use a re-ranker?") was verbatim on-claim and never
     consulted, because a *Causality* segment about the 1981 Hyatt Regency
     walkway collapse cleared tier 1 on `engineering, good, enough, step` —
     four of fifteen — and played under an agent-engineering claim. Run 1's
     Chernobyl-for-Hyatt class of failure, back in the accepted set.

     ONLY THE SEED'S OWN WINDOW MOVES AHEAD OF TIER 1. The whole-episode fallback
     (F-68's "preference, not permission") and every other candidate still run
     after it, exactly where they always did, so an unseeded beat's search order
     is untouched and a seeded beat whose window does not carry the claim gets
     the pool's chance next, then the archive's. The floor is F-72's, unchanged. */
  let seedTrial: Tier2Progress | null = null;
  const seeded = beat.seed ? candidates.find((c) => c.fromSeed) : undefined;
  if (seeded) {
    const accepted = walk.run([seeded], "seed-window");
    if (accepted) return accepted;
    /* One candidate walked, so the walk's furthest row IS the seed's own verdict:
       the gate that refused the seed window and the window's own numbers. Kept
       for the trace, whatever the rest of the walk reports (G-24 R3). */
    seedTrial = walk.furthest;
  }

  // Tier 1: existing data/segments.json pool. Cheapest possible hit,
  // tried first, per §4.5's own search order — no new segment is ever
  // created here.
  /* ONE PASS, EVERY RULE HARD (F-80). #571 ran this walk twice, the second time
     with D5's triple clause dropped, and took a uniform triple rather than lose
     the tape; run 5 was refused at finalize on exactly the triple that bought.
     A pool segment that would make one is now passed over like any other
     `tier1VetoFor` refusal, and tier 2 — which can cut a different length from
     the same passage — gets the beat next. See `durationVetoFor`. */
  /* AND THE POOL IS JUDGED WITH THE CORPUS'S OWN WORD WEIGHTS (G-24 R2). The
     text index's search for this claim — already run to gather tier 2's
     candidates — computed an idf for every claim word; tier 1's transcript-window
     bar now uses it, so a segment that shares only the trade's everyday words
     with the claim is refused the way tier 2 would refuse the same stretch
     (`tier1BarClears`). With no index there is no idf and every word weighs one. */
  const idf = candidates.find((c) => c.text?.idf)?.text?.idf;
  const tier1 = findTier1Match(claim, state.segmentPool, (segment) => tier1IsUsable(segment, state), { windowText: state.windowText, idf });
  if (tier1) {
    placeTape(tier1.segment.id, tier1.segment.item_id, tier1.segment.start_sec, tier1.segment.end_sec - tier1.segment.start_sec, state);
    return {
      kind: "tape",
      /* A pool segment is not the seeded episode's minted window even when it
         comes from the same episode: the seed names a stretch of transcript, and
         what won here is a segment a curator already cut. */
      fromSeed: false,
      nodes: nodesForPoolSegment(tier1.segment, state.root),
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
  const tier1Trace = traceTier1(claim, state, idf);

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
     is the gate a person would go and argue with — and, for a seeded beat, the
     seed's own gate beside it (G-24 R3). The walk itself is `Tier2Walk`. */
  const accepted = walk.run(candidates, "search");
  if (accepted) return accepted;

  const tier2Trace = tier2TraceFor(claim, state, archiveIsUsable, candidates, walk.furthest, beat.seed, seedTrial);

  /* Tier 3: nothing in the archive could be cut for this beat. Log ONE
     transcription-queue candidate saying how far the search got — this
     pipeline's OWN log, distinct from and never written into
     `data/transcription-queue.json`, which has its own producer
     (`tools/transcribe/build-transcription-queue.mjs`) — and let the beat
     become narration. */
  state.transcriptionQueueCandidates.push(transcriptionQueueRow(claim, walk.furthest));

  return {
    kind: "narration",
    reason: narrationReasonFor(walk.furthest),
    diagnosis: { outcome: "no-tape", tier1: tier1Trace, tier2: tier2Trace }
  };
}

/** Which of the two passes a candidate is being walked in — see `Tier2Walk.run`. */
type Tier2WalkMode = "seed-window" | "search";

/**
 * THE TIER-2 WALK, IN ONE PLACE, RUN TWICE PER SEEDED BEAT (G-24 R2).
 *
 * Everything between "here is a candidate episode" and a resolved tape pointer
 * lives here: the assembly and length ledgers, the window search and its floor,
 * the cut, the audio-source row, the minted segment, and the `furthest`
 * bookkeeping the trace reads. It is a
 * class rather than a loop inside `resolveOneBeat` because `resolveOneBeat` now
 * runs it TWICE for a seeded beat — the seed's own window before tier 1, the
 * rest of the archive after — and the two passes share one ledger and one
 * `furthest`. A second copy of the acceptance path
 * would be a second place for the ledger writes to drift out of step, which is
 * the mistake F-70 was.
 *
 * THE TWO MODES DIFFER IN WHAT IS ASKED OF THE EPISODE, NOT IN ANY THRESHOLD.
 *
 *   `"seed-window"` — one candidate, the seeded episode, and ONLY the stretch
 *   §4.3 quoted (`within`, F-68) is searched; the floor is F-72's share-only
 *   floor, unchanged. The body is opened FIRST and M4's share cap is asked after
 *   the relevance verdict, so the trace can carry the seed window's own numbers
 *   whatever refuses it — attempt 6's beat 1/0/0 was refused at `m4-share`
 *   before its body was opened, at what turned out to be a weighted share of
 *   0.746, and the row could only say "window-overlap 0.27" about a different
 *   episode (G-24 R3). The cost is one confined window search over an episode
 *   the Foray already holds tape from.
 *
 *   `"search"` — the whole candidate list, exactly the walk F-70/F-73 built: M4
 *   before the body is opened, the whole-episode window search on the searching
 *   floor, the cut, M3, the length ledger, the audio row. The seeded candidate
 *   is walked again here ONLY if its seed window was refused for not being about
 *   the claim (`window-overlap`) — that is F-68's fallback to the rest of the
 *   hour, and it runs where it always did, after tier 1. A seed refused by any
 *   other gate was refused by the ledger, the cut or the audio row, none of
 *   which the rest of the episode can change, and the pre-G-24 walk moved on
 *   from it too (`continue`); it is skipped, and its row is already in
 *   `furthest`.
 */
class Tier2Walk {
  /** The candidate that got furthest, across both passes — what the trace
   * reports when nothing passes. Seeded by the seed pass, so the seed's own row
   * competes on progress with everything the search pass finds. */
  furthest: Tier2Progress | null = null;
  /** The seed pass's verdict, once it has run — what tells the search pass
   * whether the seeded episode has anything left to be asked. */
  private seedGate: Tier2Gate | null = null;

  constructor(
    private readonly beat: Beat,
    private readonly candidates: Tier2Candidate[],
    private readonly state: SourcingState
  ) {}

  /** Walks `list` in `mode`; returns the accepted resolution or `null`. The
   * search pass ends with the deferred second chance. */
  run(list: Tier2Candidate[], mode: Tier2WalkMode): BeatResolution | null {
    const { beat, state } = this;
    const claim = beat.claim;
    const seedPass = mode === "seed-window";

    for (const candidate of list) {
      const itemId = deriveItemId(candidate.entry);

      if (!seedPass && candidate.fromSeed && this.seedGate !== null && this.seedGate !== "window-overlap") continue;

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
         episode's tape, not narration.

         THE SEED PASS IS THE ONE EXCEPTION (G-24 R3): there the body is opened
         first and share is asked after the relevance verdict, below, so the row
         that says `m4-share` can also say what the seed window scored. */
      if (!seedPass && !m4ShareAllows(itemId, state)) {
        this.record({ candidate, gate: "m4-share" }, seedPass);
        continue;
      }
      const cues = state.cueProvider.getCues(candidate.entry);
      if (!cues) {
        this.record({ candidate, gate: "no-body" }, seedPass);
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
         lost whenever another minute scored higher. It is asked first now — in
         the seed pass, before tier 1 (G-24 R2) — and kept when it clears the
         floor.

         IT IS A PREFERENCE, NOT A PERMISSION — the same rule as the seeded
         episode itself. When the seed's window does not clear, the whole-episode
         search runs in the search pass exactly as before and the trace reports
         what that found. */
      /* AND IT IS THE ONE WINDOW JUDGED ON SHARE ALONE (F-72). The seed window
         was not found by searching — the spine READ it and wrote this claim out
         of it — so the rare-word count, which exists to refuse a window a SEARCH
         landed on for the wrong reason, is reported here but not required. The
         share floor is unchanged and every other window in this loop (the
         whole-episode fallback, every unseeded beat, every text-index and
         title candidate) faces both conditions exactly as before. The reasoning
         in full, and both floors in one place, are `TapeWindowFloor` in
         `transcriptArchiveLookup.ts`. */
      const window = seedPass
        ? selectTapeWindow(claim, cues, {
            idf: candidate.text?.idf,
            within: { startSec: beat.seed!.startSec, endSec: beat.seed!.endSec }
          })
        : selectTapeWindow(claim, cues, { idf: candidate.text?.idf });
      /* Every window faces the floor for HOW IT WAS FOUND: the seed's own on
         share, anything this search turned up on both conditions. */
      const floor = seedPass ? "seed-window" : "archive-search";
      if (!tapeWindowIsRelevant(window, floor)) {
        this.record({ candidate, gate: "window-overlap", window }, seedPass);
        continue;
      }
      /* Whether the share-only floor is what let it through, as opposed to a seed
         window that would have cleared the searching floor anyway — the trace
         carries this so a run log can count how often the rule DECIDED. */
      const seedFloor: "share-only" | undefined = seedPass && seedFloorDecided(window) ? "share-only" : undefined;
      /* M4's share, for the seed pass — asked here, after relevance, for the
         trace's sake (see the class note). The rule and the answer are the same. */
      if (seedPass && !m4ShareAllows(itemId, state)) {
        this.record({ candidate, gate: "m4-share", window, seedFloor }, seedPass);
        continue;
      }
      /* AND WHICH WORDS MARK ITS EDGES (ADR-0007). The anchors are quoted from
         the tape at the window's own boundary cues, so they can be found again in
         a listener's differently-stitched copy; growth to segment length follows
         the claim rather than padding symmetrically (F-62). */
      /* AND HOW LONG A SEGMENT IT IS CUT TO (F-73, F-80). The window is chosen
         for relevance and nothing else, which is right; the D-tier rules are
         about LENGTH, and a cut that stopped at `MIN_TAPE_SEGMENT_SEC` left them
         to whatever the window happened to be. The target comes from
         `D_TARGET_LADDER_SEC`, indexed by what this Foray has already placed, so
         consecutive segments are asked for deliberately different lengths — and
         the cut still only grows while the tape is saying the claim's own words,
         so no target is ever bought with off-claim seconds.

         THE CUT IS JUDGED BY THE ORDER RULE AND THE LENGTH LEDGER TOGETHER
         (`chooseCutForPlacement`): M3 on the span's own start, because a
         segment's place in its episode is not real until the window has been
         cut to cue boundaries (F-70); the D-tier rules on the span's own length,
         for the same reason (F-73). Both are asked BEFORE the audio-source
         resolution below, so a candidate this Foray cannot use never leaves a
         `data/segment-sources.json` row behind for an episode no segment ends up
         coming from. And when the ladder rung's own cut is the one thing D5's
         triple clause refuses, the SAME window is cut to a different length
         before the candidate is given up on (F-80) — see the chooser. */
      const choice = chooseCutForPlacement(claim, cues, window!, itemId, candidate.entry.feed_duration_sec ?? null, state);
      if (!choice) {
        this.record({ candidate, gate: "no-anchor", window, seedFloor }, seedPass);
        continue;
      }
      if ("refused" in choice) {
        this.record({ candidate, gate: choice.gate, window, span: choice.refused.span, seedFloor }, seedPass);
        continue;
      }
      /* A START THE POOL ALREADY HOLDS IS THE POOL'S (F-84). The pool's id is
         `<item_id>#<start_sec rounded>`, so a cut that begins where a committed
         segment begins has that segment's id, and the pool has room for one row
         under it. Run 6 minted `…#826-2` beside the previous Foray's `…#826`
         (same 826.36 s start; the seed pass runs before tier 1, and tier 1's
         claim-overlap bar had not admitted the pool row anyway) and the pool
         gate refused the publish. The pool's cut is placed instead — under the
         pool's id, at the pool's length, with nothing minted — and it faces the
         same ledger a tier-1 hit faces: if THAT cut is refused (already played,
         M3, a length rule), the candidate is refused with `pool-cut` and the
         walk moves on; a sibling id is never the answer. See
         `reuseCommittedCut` for why the row is reused rather than extended. */
      const committed = committedCutAt(itemId, choice.accepted.span.startSec, state);
      if (committed) {
        if (reuseVetoFor(committed, state) !== null) {
          this.record({ candidate, gate: "pool-cut", window, span: choice.accepted.span, seedFloor }, seedPass);
          continue;
        }
        return this.reuseCommittedCut(candidate, committed, seedFloor);
      }
      const accepted = this.acceptCandidate(candidate, cues, window!, choice.accepted.span, itemId, seedFloor, choice.lengthGate);
      if (accepted) return accepted;
      this.record({ candidate, gate: "no-audio-source", window, span: choice.accepted.span, seedFloor }, seedPass);
    }
    return null;
  }

  /**
   * Places the POOL'S cut at a start tier 2's window reached (F-84).
   *
   * REUSED, NOT EXTENDED — and why. The task this closes allowed either: reuse
   * the committed row's cut, or, when the new window is materially longer and
   * on-claim, extend the committed row to it. The row is reused because a pool
   * row is not this run's to change: the previous Foray's `runtime_sec` was
   * computed from that row's `end_sec`, `check-forays.mjs` recomputes every
   * Foray's runtime from the pool it is handed, and lengthening a row that
   * another Foray references would fail THAT Foray's runtime check in the same
   * commit — the exact "one Foray's publish breaks another's" a curated pool
   * exists to prevent. A cut the pool holds is a cut a person can review once;
   * a cut that moves under every run that touches its start is not. The price
   * is one placement at the pool's length rather than the ladder's target, and
   * the ledger has already been asked whether that length fits.
   *
   * Nothing is minted: no `NewSegment`, no `MintedSegmentSource` (the pool row's
   * episode is in `data/segment-sources.json` already, or the row could not
   * have been merged), no `TapeRecut` (a curator's length is not this stage's to
   * revise — `liftDurationSpread`). The pointer is tier 1 — what plays is a
   * `data/segments.json` row — and the relevance row's `poolCut` says the
   * archive search is what found it.
   */
  private reuseCommittedCut(candidate: Tier2Candidate, committed: SegmentRecord, seedFloor: "share-only" | undefined): BeatResolution {
    const { state } = this;
    placeTape(committed.id, committed.item_id, committed.start_sec, committed.end_sec - committed.start_sec, state);
    return {
      kind: "tape",
      fromSeed: candidate.fromSeed === true,
      seedFloor,
      poolCut: "reused",
      nodes: nodesForPoolSegment(committed, state.root),
      pointer: {
        segmentId: committed.id,
        itemId: committed.item_id,
        startSec: committed.start_sec,
        endSec: committed.end_sec,
        startAnchor: committed.start_anchor,
        endAnchor: committed.end_anchor,
        tier: 1,
        confidence: committed.confidence
      }
    };
  }

  /** Folds one refusal into `furthest`; in the seed pass it is also the seed's
   * verdict the search pass consults. */
  private record(progress: Tier2Progress, seedPass: boolean): void {
    this.furthest = furtherOf(this.furthest, progress);
    if (seedPass) this.seedGate = progress.gate;
  }

  /**
   * Everything between "this candidate is allowed" and the resolved tape pointer:
   * the audio-source row, the minted segment, the ledgers. One implementation
   * for both passes — the seed pass and the search pass — because a second copy
   * of it is a second place for the ledger writes to drift out of step, which is
   * the mistake F-70 was. (F-73's deferred second chance was a third caller;
   * F-80 removed it along with the preference it served.)
   *
   * Returns `null` for exactly one reason, the audio-source refusal, so the
   * caller can record that gate; every other refusal happens before it is called.
   */
  private acceptCandidate(
    candidate: Tier2Candidate,
    cues: TranscriptCue[],
    window: TapeWindow,
    span: TapeSpan,
    itemId: string,
    seedFloor: "share-only" | undefined,
    lengthGate: "d5-triple" | undefined
  ): BeatResolution | null {
    const { state } = this;
    const claim = this.beat.claim;
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
      lengthGate,
      nodes: nodesForArchiveEntry(candidate.entry, state.root),
      pointer
    };
  }
}

/* ------------------------------------------------------------------------- */
/* WHICH CUT OF A WINDOW IS PLACED (F-80).
 *
 * THE FAILURE THIS CLOSES. Run 5 narrated a 25-segment Foray end to end and
 * `check-forays.mjs` refused it at finalize: "practical-ai--tiny-recursive-
 * networks#603 / …#2297 / …#1650 are 152.0 / 142.2 / 169.4 s — three consecutive
 * durations within +/-20 % of each other (max/min 1.191)". Every one of those
 * three was a tier-2 cut of a window that could have been cut LONGER or SHORTER
 * at a cue boundary; sourcing asked for one length (the ladder rung), found it
 * inside the band, and — the clause being a preference under #571 — took it
 * anyway. The rule was never enforced where the length was decided.
 *
 * THE RULE, AS IMPLEMENTED HERE.
 *   1. The window is cut to the ladder rung for this placement, exactly as
 *      before. If that cut clears M3 and every length rule, it is the cut — the
 *      ladder stays the length policy, and a placement the clause never
 *      touched carries no `lengthGate`.
 *   2. If the rung's cut is refused by D5's triple clause ALONE — the last two
 *      placed durations and this one within +/-20 % of each other, by the
 *      checker's own arithmetic (`placementEscapesD5Triple`) — every other
 *      length this window can be cut to is tried: the ladder's other rungs
 *      first, then every cue-boundary length between `MIN_TAPE_SEGMENT_SEC` and
 *      `MAX_TAPE_SEGMENT_SEC` that the growth rule reaches (still by claim
 *      overlap only, still never across a > 5 s gap — `cutWindowToSegment` is
 *      the only thing that cuts). Within each group the cut FARTHEST from the
 *      two previous durations is preferred (`d5DistanceFromPrevious`), so the
 *      escape is by the widest margin the window allows. The first that
 *      escapes the band and clears M3 and the other three length rules is
 *      placed, and the tape-relevance row records `lengthGate: "d5-triple"` so
 *      a run log can count how often the clause chose a length.
 *   3. If NO cut of this window escapes the band, the candidate is refused
 *      with gate `d5-triple` — a fall-through to the next candidate episode,
 *      like every other gate — and the trace names the rule. The beat is
 *      narrated only when every candidate's window is like this, which is the
 *      only case in which the finished Foray could not have been given this
 *      tape at all.
 *
 * WHY THE RUNG STAYS FIRST rather than always taking the farthest cut: the
 * ladder is what builds D5's second clause (the interquartile range) and D3's
 * mean, and a cut chosen for maximum distance from its neighbours on every
 * placement would be a second length policy competing with it. The clause
 * chooses a length only when the ladder's choice would break the rule.
 */

/** One length a window can be cut to, and how it was asked for. */
interface PlacementCut {
  span: TapeSpan;
  durationSec: number;
  /** The `targetSec` that produced it. */
  targetSec: number;
  /** Whether that target is one of the ladder's own rungs. */
  ladderRung: boolean;
}

type PlacementGate = "past-duration" | "m3-order" | DurationGate;

/** The chooser's answer: the cut to place (and whether D5's triple clause is
 * what chose its length), or the cut that got furthest and the gate that
 * refused it. `null` when the window yields no anchored span at all. */
type PlacementChoice = { accepted: PlacementCut; lengthGate?: "d5-triple" } | { refused: PlacementCut; gate: PlacementGate };

/**
 * F-87 (#315): a cut may not END past the episode's feed-declared duration.
 *
 * `check-forays.mjs` refuses a segment whose `end_sec` is past its source row's
 * `duration_sec` (with 2 s of grace), and `merge-segments.mjs` compares the
 * minted `reference_duration_sec` against the same number — so a cut past it
 * is tape the checker will certainly refuse, five stages later. Run 7 attempt
 * 3 minted `causality-engineered-network--1-bp-texas-city#2292` ending at
 * 2375.72 s on an episode whose feed declares 2071 s, narrated all 81 calls
 * (acts in parallel, G-32) and was refused at act 1's partial.
 *
 * NOT CLAMPED, ON PURPOSE. A shorter cut of the same window would pass the
 * checker — and be exactly the silently wrong segment #315 describes: a
 * transcript that overruns the audio it claims to describe is a timeline that
 * cannot be trusted anywhere, and ADR-0008 measured feed duration and last cue
 * agreeing within a minute on every honest row. The window is refused whole,
 * the beat falls through to the next candidate or to narration, and the
 * trace carries both numbers. Strict rather than the checker's +2 s: a cut
 * that ends 1 s past the declared audio is still a cut past the declared audio.
 * Unknown duration (`null`) is inert — the audio-source row refuses such an
 * episode on its own (`mintSegmentSource` needs `duration_sec > 0`).
 */
function pastDurationGate(span: TapeSpan, feedDurationSec: number | null): "past-duration" | null {
  return feedDurationSec !== null && span.endSec > feedDurationSec ? "past-duration" : null;
}

/** The duration ceiling first (F-87), then M3 on the span's own start, then
 * the four length rules on its own length — the order the walk has asked them
 * in since F-73. */
function placementGateFor(cut: PlacementCut, itemId: string, feedDurationSec: number | null, state: SourcingState): PlacementGate | null {
  const pastDuration = pastDurationGate(cut.span, feedDurationSec);
  if (pastDuration) return pastDuration;
  if (!m3OrderAllows(itemId, cut.span.startSec, state)) return "m3-order";
  return durationVetoFor(itemId, cut.durationSec, state);
}

function chooseCutForPlacement(
  claim: string,
  cues: TranscriptCue[],
  window: TapeWindow,
  itemId: string,
  feedDurationSec: number | null,
  state: SourcingState
): PlacementChoice | null {
  const rungSec = tapeTargetFor(state.placedTapeCount);
  const rung = cutAtTarget(claim, cues, window, rungSec, true);
  if (!rung) return null;
  const rungGate = placementGateFor(rung, itemId, feedDurationSec, state);
  if (rungGate === null) return { accepted: rung };
  if (rungGate !== "d5-triple") return { refused: rung, gate: rungGate };

  /* The rung's cut is inside the band. Every other length this window admits,
     in preference order: the ladder's other rungs before anything else, and
     within each group the farthest from the two previous durations first. Ties
     go to the longer cut — D3's mean is served by length, and no cut here can
     pass `MAX_TAPE_SEGMENT_SEC` or the checker's 240 s L4 soft maximum. */
  const placed = state.placedDurations;
  const alternatives = admissibleCuts(claim, cues, window)
    .filter((cut) => cut.durationSec !== rung.durationSec)
    .sort((a, b) => {
      if (a.ladderRung !== b.ladderRung) return a.ladderRung ? -1 : 1;
      const byDistance = d5DistanceFromPrevious(placed, b.durationSec) - d5DistanceFromPrevious(placed, a.durationSec);
      if (byDistance !== 0) return byDistance;
      return b.durationSec - a.durationSec;
    });

  /* The trace reports the cut that got FURTHEST, by the same progress order the
     walk ranks candidates on: a cut that escaped the band and was then refused
     on M4's runtime clause got further than the rung's cut did, and that is the
     gate a person would go and argue with. */
  let furthest: { cut: PlacementCut; gate: PlacementGate } = { cut: rung, gate: rungGate };
  for (const cut of alternatives) {
    const gate = placementGateFor(cut, itemId, feedDurationSec, state);
    if (gate === null) return { accepted: cut, lengthGate: "d5-triple" };
    if (TIER2_GATE_PROGRESS[gate] > TIER2_GATE_PROGRESS[furthest.gate]) furthest = { cut, gate };
  }
  return { refused: furthest.cut, gate: furthest.gate };
}

function cutAtTarget(claim: string, cues: TranscriptCue[], window: TapeWindow, targetSec: number, ladderRung: boolean): PlacementCut | null {
  const span = cutWindowToSegment(claim, cues, window, { targetSec });
  if (!span) return null;
  return { span, durationSec: span.endSec - span.startSec, targetSec, ladderRung };
}

/**
 * Every distinct length `cutWindowToSegment` can cut this window to, each one
 * asked for once: the ladder's four rungs, then the growth rule's own path from
 * `MIN_TAPE_SEGMENT_SEC` upward, one cue at a time.
 *
 * WHY WALKING THE PATH IS EXHAUSTIVE. The growth rule's choice at each step —
 * which neighbouring cue shares more of the claim — depends only on the span it
 * has so far, never on the target, so every target yields the first point on
 * one fixed path whose length reaches it (or the path's end). Asking for "just
 * past the length we have" therefore visits each point of that path in turn,
 * and the path is every length this window can honestly be. A length that is
 * not on it is a length the growth rule would not cut — off-claim tape, or a cut
 * across a gap — and it is not offered here either.
 */
function admissibleCuts(claim: string, cues: TranscriptCue[], window: TapeWindow): PlacementCut[] {
  const cuts: PlacementCut[] = [];
  const seen = new Set<number>();
  const ask = (targetSec: number, ladderRung: boolean): number | null => {
    const cut = cutAtTarget(claim, cues, window, targetSec, ladderRung);
    if (!cut) return null;
    if (!seen.has(cut.durationSec)) {
      seen.add(cut.durationSec);
      cuts.push(cut);
    }
    return cut.durationSec;
  };
  for (const rungSec of D_TARGET_LADDER_SEC) ask(rungSec, true);
  let reached = ask(MIN_TAPE_SEGMENT_SEC, false);
  while (reached !== null && reached < MAX_TAPE_SEGMENT_SEC) {
    const next = ask(reached + PATH_STEP_SEC, false);
    if (next === null || next <= reached) break;
    reached = next;
  }
  return cuts;
}

/** How far past the length already reached the next ask sits — small enough
 * that no cue is shorter, so each ask advances the growth path by exactly one
 * cue. */
const PATH_STEP_SEC = 0.001;

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
   * window search onwards, `null` only when the episode had no usable cues. On
   * an `m4-share` row it is present only for the seed pass, where the body is
   * opened before the cap is asked (G-24 R3). */
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
     than a second opinion about it. (The seed pass asks `m4-share` after the
     relevance verdict instead — `progressOf` below is where that is accounted
     for.) */
  "m4-share": 3,
  "no-body": 4,
  /* `window-overlap` now comes FIRST of the two tape gates and `no-anchor`
     after it, because F-61 swapped their order: relevance is decided on the
     window, and only a window that passed is asked for anchors. A beat that
     reached `no-anchor` therefore got further than one that did not. */
  "window-overlap": 5,
  "no-anchor": 6,
  /* F-87: the first question asked of the cut span, before M3 — a cut that
     ends past the episode's declared audio is not a placement question at
     all, so it sits between "no anchors" and the ledger. */
  "past-duration": 7,
  "m3-order": 8,
  /* F-73's four length gates sit where the walk asks them too: after the span is
     cut (so its duration is real) and before the audio-source row is written. A
     beat that reached one of these got further than one refused on M3, because
     M3 is answered first, on the same span. */
  "d2-short-run": 9,
  "d3-mean": 10,
  "d5-triple": 11,
  "m4-runtime": 12,
  /* F-84: asked after the cut has cleared M3 and the length rules on ITS
     length — the pool's cut at the same start then faces the same ledger and
     is what refused the candidate. Further than any of them, before the
     audio-source row, which a reused pool cut never needs. */
  "pool-cut": 13,
  "no-audio-source": 14
};

/**
 * A row's progress is its gate's, with one exception: an `m4-share` row that
 * carries a window is the seed pass's, where the cap was asked AFTER the window
 * cleared relevance (G-24 R3) — so it got further than any `window-overlap`
 * row and is ranked between that gate and `no-anchor`, which is exactly where
 * the seed pass asks it. This is what makes attempt 6's beat 1/0/0 report
 * "m4-share at 0.746 on the seeded episode" rather than "window-overlap at
 * 0.27 on another one": the founder reads the reason that actually decided.
 */
function progressOf(row: Tier2Progress): number {
  if (row.gate === "m4-share" && row.window) return TIER2_GATE_PROGRESS["window-overlap"] + 0.5;
  return TIER2_GATE_PROGRESS[row.gate];
}

function furtherOf(current: Tier2Progress | null, next: Tier2Progress): Tier2Progress {
  if (!current) return next;
  return progressOf(next) > progressOf(current) ? next : current;
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
  seed: BeatSeed | undefined,
  seedTrial: Tier2Progress | null
): Tier2TraceRow {
  /* WS-L: a seeded beat that ended up narrated is the case worth reading — the
     spine wrote a claim from this episode and the tape there would not carry it.
     Stamped on every branch below, including the ones that never opened an
     episode at all. */
  /* AND THE SEED'S OWN GATE, ALONGSIDE WHATEVER THE ROW REPORTS (G-24 R3). The
     row's `gate` is the FURTHEST candidate's, and for a seeded beat that can be
     another episode entirely — attempt 6's beat 1/0/0 read "window-overlap
     0.27" on federated-learning part 1 while its seed window on part 2 had
     scored 0.746 and been refused by M4's share cap. `seedGate` is what refused
     the seed window itself, and `seedWindowWeightedShare` what it scored, so
     the reason a person reads is the reason that decided. */
  const withSeed = (row: Tier2TraceRow): Tier2TraceRow => {
    if (!seed) return row;
    const stamped: Tier2TraceRow = { ...row, seededEpisode: seed.episodeId, seedWindowWon: false };
    if (seedTrial) {
      stamped.seedGate = seedTrial.gate;
      if (seedTrial.window) stamped.seedWindowWeightedShare = Number(seedTrial.window.weightedShare.toFixed(3));
    }
    return stamped;
  };
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
    /* F-87: where the cut would have ended — read against `feedDurationSec`
       below on a `past-duration` row (run 7: 2375.72 s past 2071 s). */
    row.spanEndSec = span.endSec;
  }
  if (typeof candidate.entry.feed_duration_sec === "number") row.feedDurationSec = candidate.entry.feed_duration_sec;
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
    case "d5-triple":
      return "Tape for this beat was found, but no cut of it escapes the length of the two segments before it, and three segments of one length would make the Foray sound metronomic.";
    case "m4-runtime":
      return "Tape for this beat is in an episode that already supplies a quarter of this Foray's tape seconds, so taking more would unbalance it.";
    case "no-audio-source":
      return "Tape was found for this beat but its episode's audio cannot be resolved, so it cannot be played.";
    /* F-87: the tape exists and is about the claim; its transcript's timeline
       runs past the audio the feed declares, so no cut from it can be trusted
       to start where it says it starts (#315). */
    case "past-duration":
      return "Tape for this beat was found, but its transcript runs past the length the episode's feed declares, so a cut from it cannot be trusted to play where it says it does.";
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
  "d5-triple": "every cut of it is within a fifth of the length of each of the two segments before it",
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
    case "d5-triple":
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
    /* F-87: a genuine transcription gap, unlike the assembly refusals above — a
       body this machine transcribed from the delivered audio would carry the
       audio's own timeline, which is the one thing the publisher's cannot
       promise here (#315). */
    case "past-duration":
      return {
        claim,
        showId: candidate.entry.show_id,
        reason:
          `${found} ("${candidate.entry.title}") but the cut would end at ${furthest.span?.endSec ?? "?"} s, past the ${candidate.entry.feed_duration_sec ?? "?"} s the feed declares — ` +
          `the publisher transcript's timeline overruns the audio (#315), so no cut from it is trusted. A local transcription of the delivered audio would settle it.`
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

/* The gate's two node unions — `nodesForPoolSegment` (a segment's own `topic`
   plus its show's nodes) and `nodesForArchiveEntry` (an episode's show nodes
   plus the item-id join) — live in `taxonomyFamily.ts` since F-91: §4.2, §4.5
   and the supply measure all ask them, and one answer serves all three (see
   their headers there for why each is a union). */

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

/** The pool's own id rule (`merge-segments.mjs`'s `segmentId`):
 * `<item_id>#<start_sec rounded>`, and NOTHING ELSE. Until F-84 a collision
 * was resolved with a numeric suffix, mirroring `mintItemIds`; the pool gate
 * refuses a suffixed id ("id does not match its item_id + start_sec"), so the
 * suffix only ever deferred the failure to CI (run 6, PR #624). A collision is
 * now decided BEFORE this is called — `committedCutAt` reuses the pool's cut
 * at a shared start, and the spread pass will not re-cut onto one — so reaching
 * it here is a bug in a caller, and it says so rather than minting an id the
 * pool cannot hold. */
function mintSegmentId(itemId: string, startSec: number, existing: Set<string>): string {
  const id = `${itemId}#${Math.round(startSec)}`;
  if (existing.has(id)) {
    throw new Error(
      `sourceBeats: segment id "${id}" is already in the pool or minted by this run — a cut at a start the pool holds ` +
        "must reuse that row (F-84), never mint a sibling"
    );
  }
  existing.add(id);
  return id;
}
