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

/** M4: no one episode over this share of a Foray's segments — or, since Q-04,
    of its tape SECONDS BEYOND ITS LONGEST CLIP (`m4RuntimeAllows`). */
export const M4_ITEM_SHARE_MAX = 0.25;

/** D2: a segment under this is "short", and at most two may run consecutively
    before a segment of `D2_RECOVERY_SEC` or more is required. */
export const D2_SHORT_SEC = 60;
/** The recovery segment D2 demands after two short ones. Sourcing cannot
    PROMISE one — it does not know which beat will be next, or whether the Foray
    ends here — so it never lets the debt be taken on: see `d2RunAllows`. */
export const D2_RECOVERY_SEC = 150;

/**
 * D5, RESTATED (Q-04): no two consecutive clips within +/- `D5_TOLERANCE` of
 * the same length. The arithmetic lives in `d5Pair.ts`, mirrored from the
 * checker and pinned to it by `test/d5Pair.test.ts`; re-exported here so every
 * importer of this module's constants keeps working.
 *
 * WHAT WENT WITH THE RULES. Until Q-04 this block also mirrored D3's mean floor
 * (`D3_MEAN_FLOOR_SEC` 90 s, gated from the third placement), D5's
 * interquartile floor (`D5_IQR_FLOOR_SEC` 45 s, served by a post-placement
 * re-cut pass) and the length LADDER the two were sized against
 * (`D_TARGET_LADDER_SEC` 105/165/135/210 s, F-73; the triple clause's re-cut,
 * F-80). All three were rules about the lengths a window was CUT to. With Q-01 a
 * clip's length is what the tape's own relevance measures (`tapeExtent.ts`) —
 * a minute to half an hour, at thought boundaries — so there is no target to
 * ladder, the mean floor is served per clip by the 60 s floor, and a spread
 * over clips that vary by an order of magnitude is met by construction. The
 * pair clause is what remains of D5's listening purpose, and it is asked where
 * the length is decided (`chooseCutForPlacement`).
 */
export { D5_TOLERANCE } from "./d5Pair";

/**
 * M4, RESTATED (Q-04): "no single episode dominating", for clips that may be
 * half an hour long. A clip over this many seconds is a LONG clip, and an
 * episode may supply at most one of them per Foray — `check-forays.mjs`'s
 * `M4_LONG_CLIP_SEC`, mirrored. Five minutes is twice the longest hand cut in
 * the pool (260 s) and the point past which one clip is an act of the Foray
 * rather than a segment of it; two such acts from one episode is the episode
 * taking the Foray over. The share clause is `m4RuntimeAllows`.
 */
export const M4_LONG_CLIP_SEC = 300;

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

/**
 * TWO BEATS ANSWERED IN ONE STRETCH OF TAPE ARE ONE CLIP (F-96).
 *
 * When a beat's window lies inside, overlaps, or starts within this many
 * seconds after the clip this run minted most recently from the same episode
 * — in the same act, with nothing placed since — the clip is EXTENDED to
 * cover the beat's thought and the beat is attached to it
 * (`SourcedBeat.mergedInto`), instead of the beat being refused. Before this
 * the second beat was refused at `m4-share` (an episode's second segment
 * needs eight placed) or, past that, minted as a second clip overlapping the
 * first; both threw away the best case the founder asked for — "if there's
 * a half hour of relevant content then let it ride" — which is exactly two
 * beats' worth of one answer.
 *
 * Forty-five seconds is under one relevance window (`RELEVANCE_WINDOW_SEC`,
 * 60 s): the bridge between the two thoughts is at most the host's segue
 * between two answers, not a subject the extension already judged irrelevant
 * for a whole minute. A hole in the tape (`TAPE_CUE_GAP_MAX_SEC`) inside the
 * bridge refuses the merge, as it refuses every extension. The merged clip
 * keeps the first clip's id and start (its start anchor and its place in the
 * pool's id rule are unchanged, F-84), grows only forward, stays under
 * `TAPE_WINDOW_MAX_SEC`, and is re-asked M4's long-clip and share clauses and
 * D5's pair clause at its new length; a merge any of them refuses falls
 * through to the ordinary walk.
 */
export const MERGE_GAP_SEC = 45;
import {
  findTier1Match,
  loadSegmentPool,
  requiredOverlapFor,
  scoreSegmentsAgainstClaim,
  segmentAtStart,
  SEGMENT_START_TOLERANCE_SEC,
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
  indexCues,
  loadTranscriptArchive,
  seedFloorDecided,
  selectTapeWindow,
  tapeWindowIsRelevant,
  titleTokenScore,
  MIN_TAPE_SEGMENT_SEC,
  NullTranscriptCueProvider,
  TAPE_CUE_GAP_MAX_SEC,
  TAPE_WINDOW_MAX_SEC,
  TIER2_MATCH_THRESHOLD,
  TIER2_WINDOW_MIN_SHARE,
  TIER2_WINDOW_MIN_TERMS,
  type TapeBoundary,
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
import { d5EscapeBelow, placementEscapesD5Pair } from "./d5Pair";
import { extendToThought, thoughtTerms, type ThoughtExtent } from "./tapeExtent";

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
  /**
   * F-98 (B): whether a committed pool row at a start this run's window reached
   * may be SUPERSEDED by a longer cut of the same window, rather than reused at
   * its own length (F-84).
   *
   * The rule the predicate encodes lives with the caller because only the caller
   * can read `data/forays.json`: a row is supersedable when it is still
   * `needs_review: true` — no person has listened to it — and every Foray that
   * references it is a generated draft (`generated: true`, `status: "draft"`).
   * Anything else is somebody's: a curated row, a published Foray's clip, a row
   * a person shortened on purpose. `runPipeline.ts` supplies the predicate.
   *
   * INERT WHEN OMITTED, like `topic` and `audioSourceFor` above and for the same
   * reason: a caller that cannot read the Foray list must not guess, and gets
   * exactly the unconditional reuse this module did before F-98.
   */
  supersedableCut?: (segment: SegmentRecord) => boolean;
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
  /* And the D-tier ledger (F-73, restated by Q-04): the durations of everything
     placed, in playing order, plus the tape seconds each episode has contributed
     and the longest single clip it has contributed. D2 and D5's pair clause are
     functions of the first; M4's runtime clause is a function of the other
     three. Foray-wide for the same reason as the two above — the running order
     they judge is the whole Foray's. */
  const placedDurations: number[] = [];
  const placedSecByItem = new Map<string, number>();
  const longestSecByItem = new Map<string, number>();
  /* Which episode each placement came from and where in it, positionally
     parallel to `placedDurations`. */
  const placed: PlacedSegment[] = [];

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
    supersedableCut: options.supersedableCut,
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
    longestSecByItem,
    placed,
    lastMintedClip: null
  };
  const tapeRelevance: TapeRelevanceInput[] = [];
  /* One row per narration-degraded beat, saying what each tier saw and which
     gate refused it (F-49). The two arrays partition the Foray's beats. */
  const sourcingTrace: SourcingTrace[] = [];

  const acts: SourcedAct[] = deepenedActs.map((act, actIndex) => {
    /* The act's thesis rides along (Q-01): the thought extension scores the
       tape around a claim against the claim AND the thesis it serves, so an
       answer that moves from the one to the other is still relevant tape.
       AND THE THESIS'S OWN IDF WITH IT (F-96): the idf a candidate carries is
       the claim search's and holds the claim's terms only, so the thesis's
       words weighed one each — the weight of the claim's rarest word — and
       run 9's extension stopped almost at once (`tapeExtent.ts`,
       `relevanceScorer`). One index query per act, and the thesis is weighed
       the way the claim is. */
    const actContext: ActContext = { index: actIndex, thesis: act.thesis, thesisIdf: thesisIdfFor(act.thesis, state) };
    const slots: SourcedSlot[] = act.slots.map((slot, slotIndex) => {
      // Resolve tape-or-not for every beat in the slot FIRST, because the
      // Patch/Carry decision needs to know whether ANY beat in this slot —
      // not just this one — ended up tape-sourced (§4.5: "pick based on
      // whether the SLOT the beat belongs to has any other tape-sourced
      // beats").
      const resolutions = slot.beats.map((beat, beatIndex) => resolveOneBeat(beat, state, actContext, { slot: slotIndex, beat: beatIndex }));
      const slotHasTape = resolutions.some((r) => r.kind === "tape");

      const beats: SourcedBeat[] = slot.beats.map((beat, beatIndex) => {
        const resolution = resolutions[beatIndex]!;
        if (resolution.kind === "tape") {
          const row: TapeRelevanceInput = {
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
            /* Q-04: and whether D5's pair clause is what chose this segment's
               LENGTH — the full extent would have been within 20 % of the
               previous clip, and a shorter extent of the same window escaped. */
            lengthGate: resolution.lengthGate,
            /* Q-01: what kind of boundary the clip landed on and how far past
               the claim window relevance carried it — the two numbers the
               ledger reads to say how often a real boundary was found. */
            boundary: resolution.boundary,
            extendedBySec: resolution.extendedBySec,
            /* F-84: and whether the tape is the pool's own cut at the start
               tier 2's window reached — reused, never minted beside. */
            poolCut: resolution.poolCut,
            /* F-96: and, for a pool cut, how much longer this run's own
               extent of the same window was — the seconds the pool's id rule
               cost the listener, counted so a run log can say so. */
            ...(resolution.poolCutShortBySec !== undefined ? { poolCutShortBySec: resolution.poolCutShortBySec } : {}),
            /* F-96: the beat rides in an earlier beat's clip, extended to
               cover it (`MERGE_GAP_SEC`); the row names that beat. */
            ...(resolution.mergedInto ? { mergedInto: resolution.mergedInto } : {})
          };
          tapeRelevance.push(row);
          /* A later beat merged into this clip lengthens it; the row that
             says how far it was extended has to follow (F-96). */
          if (state.lastMintedClip && state.lastMintedClip.pointer === resolution.pointer && !resolution.mergedInto) {
            state.lastMintedClip.relevanceRow = row;
          }
          return {
            sourcing: "tape",
            claim: beat.claim,
            exploration: beat.exploration,
            kind: beat.kind,
            tape: resolution.pointer,
            ...(resolution.mergedInto ? { mergedInto: resolution.mergedInto } : {})
          };
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
        return {
          sourcing: "narration",
          claim: beat.claim,
          exploration: beat.exploration,
          kind: beat.kind,
          narration: { mode, reason },
          /* F-96: a seeded beat that ends as narration has lost its seed —
             the tape the spine wrote it from is not in the Foray. Carried for
             the writer and verifier (see `SourcedBeatSchema`). */
          ...(beat.seed ? { seedLost: true as const } : {})
        };
      });

      return { title: slot.title, beats };
    });

    return { title: act.title, slots };
  });

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
  /** See `SourceBeatsOptions.supersedableCut` — undefined means nothing is
   * supersedable and every committed cut is reused at its own length (F-84). */
  supersedableCut: ((segment: SegmentRecord) => boolean) | undefined;
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
   * playing order here, and `check-forays.mjs` reads D2/D5 off exactly this
   * sequence (segments only; narration and jingles are not cuts). */
  placedDurations: number[];
  /** Tape SECONDS per episode — M4's runtime clause (F-73, restated Q-04). */
  placedSecByItem: Map<string, number>;
  /** And the longest single clip per episode — what M4's runtime clause now
   * excludes from the share, and what its one-long-clip clause counts. */
  longestSecByItem: Map<string, number>;
  /** Where each placement came from, positionally parallel to
   * `placedDurations` — see the declaration in `sourceBeats`. */
  placed: PlacedSegment[];
  /** The one clip a later beat's window may merge into (F-96) — the last
   * segment this run minted, while nothing has been placed after it. */
  lastMintedClip: LastMintedClip | null;
}

/** One placement's identity, for the rules the spread pass has to re-ask about
 * the whole finished running order rather than about one more candidate. */
interface PlacedSegment {
  itemId: string;
  startSec: number;
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
   * `lengthGate` — D5's pair clause chose this cut's LENGTH (Q-04): the full
   * thought extent would have been within 20 % of the previous clip; absent
   * whenever the full extent escaped by itself, for the same counting reason.
   * `boundary` / `extendedBySec` — where the clip's edges landed and how far
   * relevance carried it past the claim window (Q-01); absent for a pool cut.
   * `poolCut` — tier 2's window began where a committed pool segment begins and
   * the pool's cut was placed under its own id instead of a minted sibling
   * (F-84). */
  | {
      kind: "tape";
      pointer: TapePointer;
      nodes: string[];
      fromSeed: boolean;
      seedFloor?: "share-only";
      lengthGate?: "d5-pair";
      boundary?: TapeBoundary;
      extendedBySec?: number;
      poolCut?: "reused";
      /** F-96: for a reused pool cut, how many seconds longer this run's
       * extent of the same window would have been. */
      poolCutShortBySec?: number;
      /** F-96: the beat rides in an earlier beat's clip (`MERGE_GAP_SEC`);
       * the position of that beat. */
      mergedInto?: BeatAt;
    }
  | { kind: "narration"; reason: string; diagnosis: SourcingDiagnosis };

/** A beat's position inside its act — the `carriedBy` shape narration
 * beats already use, on the sourcing side (F-96). */
export interface BeatAt {
  slot: number;
  beat: number;
}

/** What one act hands every beat it sources: its index, its thesis, and the
 * thesis's own idf from the text index (F-96) — `undefined` when the index is
 * the Null one or the thesis found no episode at all. */
interface ActContext {
  index: number;
  thesis: string | null;
  thesisIdf: ReadonlyMap<string, number> | undefined;
}

/**
 * THE CLIP A LATER BEAT MAY MERGE INTO (F-96): the segment this run minted
 * most recently, kept only while nothing has been placed after it
 * (`placeTape` clears it). Holds live references — the `NewSegment` in
 * `newSegments`, the `TapePointer` the first beat's `SourcedBeat` carries, the
 * relevance row — because a merge LENGTHENS a clip that has already been
 * returned to the caller, and every copy of its end has to move together.
 */
interface LastMintedClip {
  itemId: string;
  actIndex: number;
  at: BeatAt;
  /** The first beat's claim — what the merged clip is cut and anchored with. */
  claim: string;
  segment: NewSegment;
  pointer: TapePointer;
  span: TapeSpan;
  cues: TranscriptCue[];
  /** The first beat's claim window, so `extendedBySec` keeps meaning
   * "seconds past the claim window" after a merge. */
  claimStartSec: number;
  claimEndSec: number;
  /** The clip's slot in `placedDurations` / `placed`. */
  placedIndex: number;
  feedDurationSec: number | null;
  /** The first beat's resolution — `sourceBeats` builds its relevance row
   * from it AFTER the slot's beats have all resolved, so a merge made by a
   * later beat of the slot has to have moved these numbers already. */
  resolution: Extract<BeatResolution, { kind: "tape" }>;
  relevanceRow?: TapeRelevanceInput;
}

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
type DurationGate = "d2-short-run" | "d5-pair" | "m4-runtime";

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
  return placementAllows(itemId, durationSec, state);
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

/* D5's pair clause is `placementEscapesD5Pair` in `d5Pair.ts` (Q-04): the
   checker's own arithmetic, asked against the most recently placed duration
   because that is the only pair this placement can create. When it refuses a
   tier-2 cut the chooser asks the same window for a shorter extent first —
   `chooseCutForPlacement`. */

/**
 * M4's RUNTIME clause, restated for clips that may be half an hour long (Q-04).
 * `check-forays.mjs` is the authority; this is its arithmetic, mirrored.
 *
 * TWO CLAUSES, ONE PURPOSE — no single episode dominating the Foray:
 *   1. at most ONE long clip (over `M4_LONG_CLIP_SEC`) per episode — a
 *      thirty-minute answer is one act of the Foray, and a second one from the
 *      same episode is that episode taking the Foray over;
 *   2. an episode's tape seconds BEYOND ITS LONGEST CLIP are at most
 *      `M4_ITEM_SHARE_MAX` of the Foray's tape.
 *
 * WHY THE LONGEST CLIP IS LEFT OUT OF THE SHARE. Until Q-04 the clause was the
 * plain share of the tape seconds, asked from an episode's second segment on;
 * a single clip could not trip it because no clip could pass 240 s. Now a
 * single clip can be 1,800 s, and the founder's own instruction is that it may
 * ("if there's a half hour of relevant content then let it ride", 2026-09-12)
 * — a share cap a let-it-ride clip trips by construction would be a cap on
 * exactly the thing the founder asked for. Leaving each episode's longest clip
 * out of both the numerator and nothing else keeps the 25 % line where it was
 * for everything an episode contributes BESIDES that one clip: two 290 s
 * clips from one episode in a 2,000 s Foray are 14.5 % beyond the longest and
 * pass, four of them are 43.5 % and are refused, exactly as the old share would
 * have refused them. The number is unchanged; what it is measured on is.
 *
 * The first-segment exemption #569 gave is no longer needed: an episode's first
 * clip IS its longest, so its share beyond it is zero and clause 1 cannot count
 * two. From the second clip on both clauses are asked in full.
 */
function m4RuntimeAllows(itemId: string, durationSec: number, state: SourcingState, replacing?: number): boolean {
  const view = episodeLedgerExcluding(itemId, state, replacing);
  if (durationSec > M4_LONG_CLIP_SEC && view.longestOtherSec > M4_LONG_CLIP_SEC) return false;
  const episodeSec = view.episodeOtherSec + durationSec;
  const beyondLongest = episodeSec - Math.max(view.longestOtherSec, durationSec);
  const totalSec = view.otherTapeSec + durationSec;
  if (!(totalSec > 0)) return true;
  return beyondLongest / totalSec <= M4_ITEM_SHARE_MAX;
}

/** What the three Foray-wide ledgers say about an episode and about the tape
 * WITHOUT the clip at `replacing` — the one view both callers of
 * `m4RuntimeAllows` need. A fresh placement excludes nothing and reads the maps
 * straight; a MERGE (F-96) is re-asking the rules at the clip's new length, and
 * the clip's old length is already in every figure, so it is taken out first.
 *
 * `longestSecByItem` is a running maximum and cannot have one clip removed from
 * it, so the merge path recomputes the episode's longest OTHER clip by scanning
 * `state.placed`/`state.placedDurations`. That scan is the only thing the two
 * paths do differently, and it is here rather than in two copies of the rule. */
function episodeLedgerExcluding(
  itemId: string,
  state: SourcingState,
  replacing?: number
): { episodeOtherSec: number; longestOtherSec: number; otherTapeSec: number } {
  if (replacing === undefined) {
    return {
      episodeOtherSec: state.placedSecByItem.get(itemId) ?? 0,
      longestOtherSec: state.longestSecByItem.get(itemId) ?? 0,
      otherTapeSec: state.placedDurations.reduce((a, b) => a + b, 0)
    };
  }
  const before = state.placedDurations[replacing] ?? 0;
  let longestOtherSec = 0;
  let otherTapeSec = 0;
  state.placed.forEach((p, i) => {
    if (i === replacing) return;
    const d = state.placedDurations[i] ?? 0;
    otherTapeSec += d;
    if (p.itemId === itemId) longestOtherSec = Math.max(longestOtherSec, d);
  });
  return { episodeOtherSec: (state.placedSecByItem.get(itemId) ?? 0) - before, longestOtherSec, otherTapeSec };
}

/**
 * THE ONE PLACEMENT PREDICATE (F-101). Every length rule sourcing enforces,
 * asked once, for both the tier that places a clip and the tier that grows one.
 *
 * `replacing` is the index in `state.placed`/`state.placedDurations` of a clip
 * this placement REPLACES rather than adds — a merge (F-96) re-asking the rules
 * at the merged clip's new length. It changes two things and only two:
 *
 *   D2  is skipped. The merged clip only grew, and D2 is a rule about runs of
 *       SHORT segments; a clip that was legal at its old length cannot be made
 *       illegal by getting longer, and asking `d2RunAllows` against the clip
 *       BEFORE it would judge it against its own predecessor twice.
 *   D5  is asked against the placements before the replaced clip, because
 *       nothing sits after it (a clip with a placement after it is closed to
 *       merging — `placeTape` clears `lastMintedClip`), so the only pair this
 *       length can create is with the clip before.
 *
 * M4 is asked in full either way, through `episodeLedgerExcluding`.
 *
 * WHY THIS EXISTS. F-96 wrote the merge's copy of M4's runtime clause as a
 * second, hand-mirrored implementation of the same formula over the same
 * ledgers (`mergedClipEscapesLengthRules`). Two copies of a rule that must
 * agree is the drift this file spends four hundred lines guarding against
 * everywhere else; one of them would eventually be updated alone.
 */
export function placementAllows(
  itemId: string,
  durationSec: number,
  state: SourcingState,
  options: { replacing?: number } = {}
): DurationGate | null {
  const { replacing } = options;
  if (replacing === undefined && !d2RunAllows(durationSec, state)) return "d2-short-run";
  const priorDurations = replacing === undefined ? state.placedDurations : state.placedDurations.slice(0, replacing);
  if (!placementEscapesD5Pair(priorDurations, durationSec)) return "d5-pair";
  if (!m4RuntimeAllows(itemId, durationSec, state, replacing)) return "m4-runtime";
  return null;
}

/** Writes one tape placement into every Foray-wide ledger. The ONLY place they
 * move, so the two tiers cannot drift apart on what "placed" means — which is
 * exactly how tier 2 came to consult none of them.
 *
 * F-101 — AND THE MERGE GOES THROUGH HERE TOO, so the sentence above is true
 * again. F-96's `mergeIntoClip` wrote `placedDurations`, `placedSecByItem` and
 * `longestSecByItem` inline, outside this function, which is precisely the
 * drift this comment claimed could not happen. `replacing` is the index of the
 * clip whose length changed: the used-segment, start-order and count ledgers do
 * not move (no new clip was placed, and the clip is still where it was), and
 * `lastMintedClip` is NOT cleared, because a merged clip stays open to the next
 * beat of the same slot. */
function placeTape(
  segmentId: string,
  itemId: string,
  startSec: number,
  durationSec: number,
  state: SourcingState,
  options: { replacing?: number } = {}
): void {
  const { replacing } = options;
  if (replacing !== undefined) {
    const before = state.placedDurations[replacing] ?? 0;
    state.placedDurations[replacing] = durationSec;
    state.placedSecByItem.set(itemId, (state.placedSecByItem.get(itemId) ?? 0) - before + durationSec);
    state.longestSecByItem.set(itemId, Math.max(state.longestSecByItem.get(itemId) ?? 0, durationSec));
    return;
  }
  /* A placement after a minted clip closes it to merging (F-96): a beat
     whose tape sits after ANOTHER clip in play order is not adjacent to it. */
  state.lastMintedClip = null;
  state.usedSegmentIds.add(segmentId);
  state.lastStartByItem.set(itemId, startSec);
  state.usedCountByItem.set(itemId, (state.usedCountByItem.get(itemId) ?? 0) + 1);
  state.placedTapeCount += 1;
  state.placedDurations.push(durationSec);
  state.placed.push({ itemId, startSec });
  state.placedSecByItem.set(itemId, (state.placedSecByItem.get(itemId) ?? 0) + durationSec);
  state.longestSecByItem.set(itemId, Math.max(state.longestSecByItem.get(itemId) ?? 0, durationSec));
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

/** The lineage gate as a predicate over archive entries — what tier 2's
 * candidate search and the act's thesis query (F-96) both filter by. */
function usableArchiveEntry(state: SourcingState): (entry: TranscriptDigestEntry) => boolean {
  return (entry: TranscriptDigestEntry) => familyGateAllows(state.forayTopic, nodesForArchiveEntry(entry, state.root), state.root);
}

/**
 * The idf of the act's thesis's terms, from the same index and the same
 * usable shows the claim searches run over (F-96). One query per act; the
 * Null index answers nothing and the thesis is then weighed one per word,
 * which is what every test written before F-96 already saw.
 */
function thesisIdfFor(thesis: string | null, state: SourcingState): ReadonlyMap<string, number> | undefined {
  if (!thesis || !state.textIndex.enabled) return undefined;
  return state.textIndex.search(thesis, { limit: 1, isUsable: usableArchiveEntry(state) })[0]?.idf;
}

/** The claim search's idf over the thesis's — a term the claim search
 * weighed keeps that weight; the rest come from the thesis query. */
function mergeIdf(claimIdf: ReadonlyMap<string, number> | undefined, thesisIdf: ReadonlyMap<string, number> | undefined): ReadonlyMap<string, number> | undefined {
  if (!thesisIdf) return claimIdf;
  if (!claimIdf) return thesisIdf;
  return new Map([...thesisIdf, ...claimIdf]);
}

function resolveOneBeat(beat: Beat, state: SourcingState, act: ActContext, at: BeatAt): BeatResolution {
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
  const archiveIsUsable = usableArchiveEntry(state);
  const candidates = tier2Candidates(claim, state, archiveIsUsable, beat.seed);
  const walk = new Tier2Walk(beat, candidates, state, act, at);

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
    private readonly state: SourcingState,
    /** The act — its thesis, which the thought extension scores tape against
     * beside the claim (Q-01), with the thesis's own idf (F-96). */
    private readonly act: ActContext,
    /** Where this beat sits in the act — what a clip that merges a later
     * beat records as the beat it carries (F-96). */
    private readonly at: BeatAt
  ) {}

  /** Whether `itemId` is the episode of the clip a window could merge into
   * (F-96): this run's last minted clip, from this act, nothing placed since. */
  private mergeableInto(itemId: string): LastMintedClip | null {
    const last = this.state.lastMintedClip;
    return last && last.itemId === itemId && last.actIndex === this.act.index ? last : null;
  }

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
         that says `m4-share` can also say what the seed window scored.

         AND SO IS THE EPISODE OF THE LAST MINTED CLIP (F-96): its window may
         MERGE into that clip, which places no second segment and so owes M4's
         count nothing; the cap is asked after the merge has been tried. */
      const mergeable = this.mergeableInto(itemId);
      if (!seedPass && !mergeable && !m4ShareAllows(itemId, state)) {
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
      /* TWO BEATS IN ONE STRETCH OF TAPE ARE ONE CLIP (F-96, `MERGE_GAP_SEC`).
         The window is about the claim; if it lies inside, overlaps or sits
         just after the clip this run minted last from this episode, that clip
         is extended to cover the thought and the beat rides in it — no second
         segment, no `m4-share`, no overlapping cut. Refused merges fall
         through to the ordinary walk below. */
      if (mergeable) {
        const merged = this.mergeIntoClip(mergeable, candidate, cues, window!, seedFloor);
        if (merged) return merged;
      }
      /* M4's share, for the seed pass — asked here, after relevance, for the
         trace's sake (see the class note). The rule and the answer are the
         same. And for the mergeable episode whose merge was refused. */
      if ((seedPass || mergeable) && !m4ShareAllows(itemId, state)) {
        this.record({ candidate, gate: "m4-share", window, seedFloor }, seedPass);
        continue;
      }
      /* AND WHICH WORDS MARK ITS EDGES (ADR-0007). The anchors are quoted from
         the tape at the window's own boundary cues, so they can be found again in
         a listener's differently-stitched copy; growth to segment length follows
         the claim rather than padding symmetrically (F-62). */
      /* AND HOW LONG A SEGMENT IT IS CUT TO (Q-01, Q-04). The window is chosen
         for relevance and nothing else, which is right; the clip is the THOUGHT
         around it — the window extended to turn or sentence boundaries and then
         as far as the tape stays relevant to the claim and the act's thesis
         (`extendToThought`), a minute to half an hour. No ladder, no target: the
         length is what the tape measures.

         THE CUT IS JUDGED BY THE ORDER RULE AND THE LENGTH LEDGER TOGETHER
         (`chooseCutForPlacement`): M3 on the span's own start, because a
         segment's place in its episode is not real until the window has been
         cut to cue boundaries (F-70); the length rules on the span's own length,
         for the same reason (F-73). Both are asked BEFORE the audio-source
         resolution below, so a candidate this Foray cannot use never leaves a
         `data/segment-sources.json` row behind for an episode no segment ends up
         coming from. And when the full extent is the one thing D5's pair clause
         refuses, the SAME window is extended to a shorter boundary before the
         candidate is given up on (Q-04) — see the chooser. */
      const choice = chooseCutForPlacement(
        claim,
        this.act,
        cues,
        window!,
        candidate.text?.idf,
        itemId,
        candidate.entry.feed_duration_sec ?? null,
        state
      );
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
      /* F-98 (B): A DRAFT MINT MAY BE SUPERSEDED BY A LONGER CUT AT THE SAME
         START. Four of run 9's ten clips were run 8's pre-Q-01 rows reused at
         their old lengths — 32/70/78/152 s where this run's extent of the same
         window wanted 32/70/158/381 s — because the reuse above is
         unconditional and F-84's id rule leaves no second id to mint under.
         F-84's reasoning holds for a row a PERSON has reviewed or a published
         Foray plays: lengthening it would break that Foray's runtime check in
         the same commit. It does not hold for a row this pipeline minted, that
         nobody has listened to (`needs_review: true`) and that only generated
         DRAFT Forays reference — those Forays are ours to restate, and
         `publishForay` restates them. `supersedableCut` is the predicate that
         knows the difference; absent (every test written before this, every
         caller with no `data/forays.json` to read) nothing is supersedable and
         the reuse below is exactly what it was. */
      if (committed) {
        const supersede =
          !state.usedSegmentIds.has(committed.id) &&
          choice.accepted.durationSec > committed.end_sec - committed.start_sec + SEGMENT_START_TOLERANCE_SEC &&
          state.supersedableCut?.(committed) === true;
        if (!supersede) {
          if (reuseVetoFor(committed, state) !== null) {
            this.record({ candidate, gate: "pool-cut", window, span: choice.accepted.span, seedFloor }, seedPass);
            continue;
          }
          return this.reuseCommittedCut(candidate, committed, seedFloor, choice.accepted);
        }
      }
      const accepted = this.acceptCandidate(
        candidate,
        cues,
        window!,
        choice.accepted,
        itemId,
        seedFloor,
        choice.lengthGate,
        candidate.entry.feed_duration_sec ?? null,
        committed ?? undefined
      );
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
  private reuseCommittedCut(candidate: Tier2Candidate, committed: SegmentRecord, seedFloor: "share-only" | undefined, cut: PlacementCut): BeatResolution {
    const { state } = this;
    placeTape(committed.id, committed.item_id, committed.start_sec, committed.end_sec - committed.start_sec, state);
    /* F-96: WHAT THE POOL'S ID RULE COST. Run 9 regenerated run 8's prompt
       with run 8's sixteen pre-Q-01 cuts in the pool, and four of its ten
       clips were those cuts reused at their old length (31.9-152 s) while
       this run's extent of the same window ran 70-381 s — the seed path is
       extended like every other, and this is where the extension was lost.
       The row and the seeding line count the seconds so the run log says
       so; the remedy is a pool decision (a generated draft's rows superseded
       by a longer cut at the same start), not a sibling id (F-84). */
    const shortBy = Math.round((cut.durationSec - (committed.end_sec - committed.start_sec)) * 1000) / 1000;
    return {
      kind: "tape",
      fromSeed: candidate.fromSeed === true,
      seedFloor,
      poolCut: "reused",
      ...(shortBy > 0 ? { poolCutShortBySec: shortBy } : {}),
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
    cut: PlacementCut,
    itemId: string,
    seedFloor: "share-only" | undefined,
    lengthGate: "d5-pair" | undefined,
    feedDurationSec: number | null,
    /* F-98: the committed row this mint SUPERSEDES — same id, same start, a
       longer end. Present only when the walk decided the row is supersedable
       (a draft mint nobody has reviewed); absent on every ordinary mint, and
       then the id is minted the way F-84 requires. */
    supersedes?: SegmentRecord
  ): BeatResolution | null {
    const { state } = this;
    const claim = this.beat.claim;
    const span = cut.span;
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
    /* A supersede keeps the committed row's id — it IS that row, re-cut — so it
       does not pass through `mintSegmentId`, whose whole job is to refuse an id
       the pool already holds (F-84). The id it would have minted is the same
       string either way (`<item_id>#<start rounded>` at a start that coincides);
       what differs is that this one is allowed to collide, exactly once, with
       the row it replaces. */
    const segmentId = supersedes ? supersedes.id : mintSegmentId(itemId, span.startSec, state.mintedIds);
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
      transcriptSource: state.cueProvider.transcriptSource?.(candidate.entry) ?? "publisher",
      /* Q-01: where the clip's edges landed and how far past the claim window
         relevance carried it — onto the row, so the ledger can count both. */
      ...(span.boundary !== undefined ? { boundary: span.boundary, extendedBySec: span.extendedBySec ?? 0 } : {}),
      /* F-98: the end this cut replaces. `publishForay` writes it onto the row
         as `superseded_from` and rewrites the row in place; `mintedPoolCollisions`
         reads it to tell a deliberate supersede from the shadowing F-84 refuses. */
      ...(supersedes ? { supersedesEndSec: supersedes.end_sec } : {})
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
    placeTape(segmentId, itemId, span.startSec, span.endSec - span.startSec, state);
    const resolution: Extract<BeatResolution, { kind: "tape" }> = {
      kind: "tape",
      fromSeed: candidate.fromSeed === true,
      seedFloor,
      lengthGate,
      boundary: span.boundary,
      extendedBySec: span.extendedBySec,
      nodes: nodesForArchiveEntry(candidate.entry, state.root),
      pointer
    };
    /* The clip the NEXT beat's window may merge into (F-96) — set after
       `placeTape`, which clears it. */
    state.lastMintedClip = {
      itemId,
      actIndex: this.act.index,
      at: this.at,
      claim,
      segment,
      pointer,
      span,
      cues,
      claimStartSec: cut.extent.claimStartSec,
      claimEndSec: cut.extent.claimEndSec,
      placedIndex: state.placedDurations.length - 1,
      feedDurationSec,
      resolution
    };
    return resolution;
  }

  /**
   * MERGES THIS BEAT'S WINDOW INTO THE LAST MINTED CLIP (F-96), or returns
   * `null` and lets the walk go on. The rules, in order:
   *
   *   1. The claim window starts at or after the clip's start — the tape that
   *      carries THIS beat has to be inside the merged clip; a window that
   *      begins before the clip is a different stretch (and M3 would refuse
   *      it as a second segment anyway).
   *   2. The beat's own thought extent (`extendToThought`, same terms and idf
   *      as any cut) starts no later than `MERGE_GAP_SEC` after the clip's
   *      end, and no hole in the tape (`TAPE_CUE_GAP_MAX_SEC`) lies between
   *      the clip's last cue and the extent's first.
   *   3. The merged clip is the clip's start to the later of the two ends —
   *      it grows FORWARD only, so its id, start anchor and place in the pool
   *      (F-84) are unchanged — and stays under `TAPE_WINDOW_MAX_SEC`.
   *   4. At its new length it is re-asked what the walk asks any cut: the
   *      feed's duration (F-87), M4's one-long-clip and share clauses, and
   *      D5's pair clause against the clip placed BEFORE it (Q-04). A merge
   *      any of them refuses is not made.
   *
   * On success every live copy of the clip's end moves — the `NewSegment`,
   * the first beat's `TapePointer`, its relevance row, the length ledgers —
   * and the beat resolves to the SAME pointer with `mergedInto` naming the
   * beat whose clip it rides in. The end anchor is re-minted from the tape at
   * the new last cue exactly as `cutWindowToSegment` mints any anchor.
   */
  private mergeIntoClip(
    last: LastMintedClip,
    candidate: Tier2Candidate,
    cues: TranscriptCue[],
    window: TapeWindow,
    seedFloor: "share-only" | undefined
  ): BeatResolution | null {
    const { state } = this;
    const claim = this.beat.claim;
    if (window.startSec < last.segment.startSec) return null;
    const terms = extentTermsFor(claim, this.act, candidate.text?.idf);
    const extent = extendToThought(window, cues, { ...terms, maxSec: TAPE_WINDOW_MAX_SEC });
    if (extent.startSec > last.segment.endSec + MERGE_GAP_SEC) return null;
    const lastCue = Math.max(extent.lastCue, last.span.lastCue);
    if (holeBetweenCues(cues, last.span.lastCue, lastCue)) return null;
    const boundary = weakerBoundary(last.segment.boundary ?? "claim-only", extent.boundary);
    const mergedWindow: TapeWindow = {
      ...window,
      firstCue: last.span.firstCue,
      lastCue,
      startSec: last.segment.startSec,
      endSec: Math.max(extent.endSec, last.segment.endSec),
      boundary,
      claimStartSec: last.claimStartSec,
      claimEndSec: last.claimEndSec,
      extendedBySec: 0
    };
    if (mergedWindow.endSec - mergedWindow.startSec > TAPE_WINDOW_MAX_SEC) return null;
    /* Cut with the FIRST beat's claim: the growth (a no-op past the floor)
       and the anchors are the clip's, and `boundary` stays what the two
       extents found unless the cut has to move an edge. */
    const span = cutWindowToSegment(last.claim, cues, mergedWindow);
    if (!span || !startsCoincide(span.startSec, last.segment.startSec)) return null;
    const durationSec = span.endSec - span.startSec;
    if (pastDurationGate(span, last.feedDurationSec)) return null;
    if (!mergedClipEscapesLengthRules(last, durationSec, state)) return null;

    /* Apply — every live copy of the end, together. */
    last.segment.endSec = span.endSec;
    last.segment.endAnchor = span.endAnchor;
    last.segment.boundary = span.boundary ?? boundary;
    last.segment.extendedBySec = span.extendedBySec ?? 0;
    last.pointer.endSec = span.endSec;
    last.pointer.endAnchor = span.endAnchor;
    last.span = span;
    last.resolution.boundary = last.segment.boundary;
    last.resolution.extendedBySec = last.segment.extendedBySec;
    if (last.relevanceRow) {
      last.relevanceRow.boundary = last.segment.boundary;
      last.relevanceRow.extendedBySec = last.segment.extendedBySec;
    }
    /* F-101: through `placeTape`, like every other ledger write in this file,
       so the invariant its comment claims is true. */
    placeTape(last.segment.id, last.itemId, last.segment.startSec, durationSec, state, { replacing: last.placedIndex });

    return {
      kind: "tape",
      fromSeed: candidate.fromSeed === true,
      seedFloor,
      boundary: last.segment.boundary,
      extendedBySec: last.segment.extendedBySec,
      nodes: nodesForArchiveEntry(candidate.entry, state.root),
      pointer: last.pointer,
      mergedInto: last.at
    };
  }
}

/** Whether a hole in the tape (`TAPE_CUE_GAP_MAX_SEC`) lies between cue
 * `from` and cue `to` of the indexed cue list `cutWindowToSegment` counts by. */
function holeBetweenCues(cues: TranscriptCue[], from: number, to: number): boolean {
  const index = indexCues(cues);
  for (let k = from + 1; k <= to && k < index.cues.length; k++) {
    if (index.cues[k]!.start_sec - index.cues[k - 1]!.end_sec > TAPE_CUE_GAP_MAX_SEC) return true;
  }
  return false;
}

const BOUNDARY_RANK: Record<TapeBoundary, number> = { "claim-only": 0, sentence: 1, turn: 2 };
function weakerBoundary(a: TapeBoundary, b: TapeBoundary): TapeBoundary {
  return BOUNDARY_RANK[a] <= BOUNDARY_RANK[b] ? a : b;
}

/**
 * The length rules a MERGED clip is re-asked at its new length (F-96) — now
 * literally `placementAllows` with `replacing` set (F-101), rather than a
 * second hand-mirrored copy of M4's arithmetic. Everything the merge needs to
 * say differently is said by that one argument: D2 cannot refuse a clip that
 * only grew; D5's pair is against the placement BEFORE the clip (nothing has
 * been placed after it, or it could not be merged into); M4's clauses read the
 * episode's seconds with this clip at its new length and its old length taken
 * out of every figure it appears in.
 */
function mergedClipEscapesLengthRules(last: LastMintedClip, durationSec: number, state: SourcingState): boolean {
  return placementAllows(last.itemId, durationSec, state, { replacing: last.placedIndex }) === null;
}

/* ------------------------------------------------------------------------- */
/* WHICH CUT OF A WINDOW IS PLACED (Q-01, Q-04).
 *
 * THE WINDOW `selectTapeWindow` FOUND IS WHERE THE CLAIM IS SPOKEN; THE CLIP IS
 * THE THOUGHT AROUND IT. `extendToThought` (`tapeExtent.ts`) moves the window's
 * edges to the boundaries of the speaker's turn or sentence and then as far as
 * the tape stays relevant to the claim and the act's thesis — a minute to half
 * an hour. `cutWindowToSegment` then cuts that extent to whole cues with the
 * tape's own words as anchors, exactly as it cut the bare window before Q-01.
 * There is no ladder any more (F-73's `D_TARGET_LADDER_SEC`) and no target: a
 * clip's length is what the tape measures, and the D-tier rules were restated
 * for that (Q-04 — `d5Pair.ts`, `m4RuntimeAllows`).
 *
 * THE ONE RULE THAT CAN ASK FOR A DIFFERENT LENGTH IS D5's PAIR CLAUSE. When
 * the full extent would be within 20 % of the previous clip's length, the same
 * window is extended again with a ceiling just under the band
 * (`d5EscapeBelow`), so relevance stops one boundary earlier and the pair
 * escapes; the tape-relevance row records `lengthGate: "d5-pair"` so a run log
 * can count the placements the clause decided. If even that cut is refused —
 * by the pair clause again (the ceiling fell under the 60 s floor, or the
 * boundary before it was still inside the band) or by any other gate — the
 * candidate is refused with the gate that got furthest, a fall-through to the
 * next episode like every other gate. A LONGER escape is never asked for: the
 * extent is already as long as relevance allows, and a clip bought with tape
 * relevance refused would be F-62's padding back under another name.
 */

/** One length a window can be cut to, and the extent it was cut from. */
interface PlacementCut {
  span: TapeSpan;
  durationSec: number;
  extent: ThoughtExtent;
}

type PlacementGate = "past-duration" | "m3-order" | DurationGate;

/** The chooser's answer: the cut to place (and whether D5's pair clause is
 * what chose its length), or the cut that got furthest and the gate that
 * refused it. `null` when the window yields no anchored span at all. */
type PlacementChoice = { accepted: PlacementCut; lengthGate?: "d5-pair" } | { refused: PlacementCut; gate: PlacementGate };

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
 * the length rules on its own length — the order the walk has asked them in
 * since F-73. */
function placementGateFor(cut: PlacementCut, itemId: string, feedDurationSec: number | null, state: SourcingState): PlacementGate | null {
  const pastDuration = pastDurationGate(cut.span, feedDurationSec);
  if (pastDuration) return pastDuration;
  if (!m3OrderAllows(itemId, cut.span.startSec, state)) return "m3-order";
  return durationVetoFor(itemId, cut.durationSec, state);
}

/** What the extension scores relevance against: the claim's own terms and the
 * act's thesis, with the corpus idf the window search used. */
interface ExtentTerms {
  claimTerms: string[];
  thesisTerms: string[];
  idf: ReadonlyMap<string, number> | undefined;
}

/** The claim's terms, the act's thesis's terms, and the claim search's idf
 * merged with the thesis's own (F-96) — what every extension of this beat's
 * window scores relevance with. */
function extentTermsFor(claim: string, act: ActContext, claimIdf: ReadonlyMap<string, number> | undefined): ExtentTerms {
  return {
    claimTerms: thoughtTerms(claim),
    thesisTerms: act.thesis ? thoughtTerms(act.thesis) : [],
    idf: mergeIdf(claimIdf, act.thesisIdf)
  };
}

function chooseCutForPlacement(
  claim: string,
  act: ActContext,
  cues: TranscriptCue[],
  window: TapeWindow,
  idf: ReadonlyMap<string, number> | undefined,
  itemId: string,
  feedDurationSec: number | null,
  state: SourcingState
): PlacementChoice | null {
  const terms = extentTermsFor(claim, act, idf);
  const full = cutExtent(claim, cues, window, terms, undefined);
  if (!full) return null;
  const fullGate = placementGateFor(full, itemId, feedDurationSec, state);
  if (fullGate === null) return { accepted: full };
  if (fullGate !== "d5-pair") return { refused: full, gate: fullGate };

  /* The full extent is inside the band with the previous clip. Ask the same
     window for the longest extent that escapes UNDER it — still at a thought
     boundary, still only tape relevance kept — and judge that cut by every
     rule in turn. */
  const ceiling = d5EscapeBelow(state.placedDurations);
  const shorter = ceiling !== null && ceiling >= MIN_TAPE_SEGMENT_SEC ? cutExtent(claim, cues, window, terms, ceiling) : null;
  if (!shorter || shorter.durationSec >= full.durationSec) return { refused: full, gate: fullGate };
  const gate = placementGateFor(shorter, itemId, feedDurationSec, state);
  if (gate === null) return { accepted: shorter, lengthGate: "d5-pair" };
  /* The trace reports the cut that got FURTHEST, by the same progress order the
     walk ranks candidates on. */
  return TIER2_GATE_PROGRESS[gate] > TIER2_GATE_PROGRESS[fullGate] ? { refused: shorter, gate } : { refused: full, gate: fullGate };
}

/** The window extended to its thought (to `maxSec` when given) and cut to
 * anchored cues — `null` only when the tape yields no anchor. */
function cutExtent(claim: string, cues: TranscriptCue[], window: TapeWindow, terms: ExtentTerms, maxSec: number | undefined): PlacementCut | null {
  const extent = extendToThought(window, cues, {
    claimTerms: terms.claimTerms,
    thesisTerms: terms.thesisTerms,
    idf: terms.idf,
    ...(maxSec !== undefined ? { maxSec } : {})
  });
  /* The same ceiling on the floor growth: a cut shortened to escape D5's band
     must not be grown back into it one cue at a time. */
  const span = cutWindowToSegment(claim, cues, extent, maxSec !== undefined ? { maxSec } : {});
  if (!span) return null;
  return { span, durationSec: span.endSec - span.startSec, extent };
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
  /* The length gates sit where the walk asks them too: after the span is cut
     (so its duration is real) and before the audio-source row is written. A
     beat that reached one of these got further than one refused on M3, because
     M3 is answered first, on the same span. `d3-mean` is no longer asked (Q-04)
     and keeps a slot only so a checkpoint written under F-73 still ranks. */
  "d2-short-run": 9,
  "d3-mean": 10,
  "d5-pair": 10,
  "m4-runtime": 11,
  /* F-84: asked after the cut has cleared M3 and the length rules on ITS
     length — the pool's cut at the same start then faces the same ledger and
     is what refused the candidate. Further than any of them, before the
     audio-source row, which a reused pool cut never needs. */
  "pool-cut": 12,
  "no-audio-source": 13
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
    if (span.boundary !== undefined) {
      row.boundary = span.boundary;
      row.extendedBySec = span.extendedBySec ?? 0;
    }
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
    case "d5-pair":
      return "Tape for this beat was found, but no cut of it escapes the length of the segment before it, and two segments of one length in a row would make the Foray sound metronomic.";
    case "m4-runtime":
      return "Tape for this beat is in an episode that already supplies a long clip or a quarter of this Foray's tape seconds beyond its longest clip, so taking more would let one episode dominate.";
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
  "d5-pair": "every cut of it is within a fifth of the length of the segment before it",
  "m4-runtime": "the episode already supplies a long clip, or its quarter of the tape seconds beyond its longest clip"
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
    case "d5-pair":
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
