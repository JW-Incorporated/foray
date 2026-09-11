import { z } from "zod";
import type { MintedSegmentSource } from "../generation/audioSourceLookup";
import { BeatKindSchema, type Beat, type DeepenedAct } from "./spine";

/**
 * §4.5-4.6 output types (docs/curation/generation-architecture.md §4.5,
 * §4.6). Takes §4.4's `DeepenedAct[]` (backend/src/types/spine.ts) as
 * input and decides, per beat, HOW it gets sourced: real tape (§4.6
 * resolves the pointer) or narration (flagged Patch/Carry for §4.7,
 * which is explicitly NOT built here).
 *
 * GUARDRAIL THIS MODULE ENFORCES STRUCTURALLY (§4.5's own guardrail,
 * non-negotiable): "tape presence must never dictate which acts/beats
 * exist — that was already decided at spine-build time." This stage only
 * ever ANNOTATES an existing beat with a sourcing decision; nothing here
 * can add, remove, or reorder a beat. See `validateSourcing` below,
 * which is the structural check for that guarantee — mirrors
 * `validateDeepenedAct` in spine.ts.
 *
 * §1.1 SEEK-AND-STOP: a `TapePointer` carries only numbers and quoted
 * anchor text — the existing `data/segments.json` contract
 * (docs/curation/segment-extraction-pipeline.md §4), matched field-for-
 * field. It is never an audio byte, never a fetched/downloaded asset.
 */

/** Matches `data/segments.json`'s field names exactly (see that file's
 * top and docs/curation/segment-extraction-pipeline.md §4) so a §4.6
 * pointer can be resolved against the real pool with zero translation. */
export const TapePointerSchema = z
  .object({
    /** The `data/segments.json` id this pointer resolves to — either an
     * EXISTING segment's id (tier 1) or a freshly-minted one for a
     * segment this stage's tier-2 path just produced (not yet merged
     * into `data/segments.json`; see `NewSegment` below). */
    segmentId: z.string().trim().min(1),
    itemId: z.string().trim().min(1),
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
    /** Verbatim text anchors — "the text anchors that let boundaries be
     * re-derived if audio shifts" (§4.6). Never a raw timestamp alone. */
    startAnchor: z.string().trim().min(1),
    endAnchor: z.string().trim().min(1),
    /** Which §4.5 search-order tier resolved this beat. 1 = existing
     * `data/segments.json` hit (cheapest, no new segment). 2 = a hit in
     * the transcript archive that produced a NEW segment via the
     * existing extraction path. */
    tier: z.union([z.literal(1), z.literal(2)]),
    confidence: z.enum(["high", "medium", "low"])
  })
  .strict()
  .refine((p) => p.endSec > p.startSec, { message: "endSec must be greater than startSec" });
export type TapePointer = z.infer<typeof TapePointerSchema>;

/** §2.1's six narration modes reduced to the two this stage can assign
 * (Patch, Carry) — every other mode (Hinge/Frame/Marker/Correction)
 * belongs to §4.7's writing stage, which owns modes for beats that DO
 * have tape and need connective narration around it; that is out of
 * scope here (see the task's "What NOT to build" list). */
export const NarrationAssignmentSchema = z
  .object({
    mode: z.enum(["Patch", "Carry"]),
    /** Why this mode was picked — audit trail for the Patch/Carry
     * decision ("slot has other tape-sourced beats" / "slot has none"),
     * and the field §4.7 needs to know it is writing this beat at all. */
    reason: z.string().trim().min(1)
  })
  .strict();
export type NarrationAssignment = z.infer<typeof NarrationAssignmentSchema>;

/** One beat, annotated with its §4.5 sourcing decision. Discriminated on
 * `sourcing` so a beat can never carry both a tape pointer and a
 * narration assignment, or neither. */
export const SourcedBeatSchema = z.discriminatedUnion("sourcing", [
  z
    .object({
      sourcing: z.literal("tape"),
      claim: z.string().trim().min(1),
      exploration: z.boolean(),
      /** Carried through from §4.4 so §4.7 knows what it is writing around;
       * absent means `account` (see BeatKindSchema in types/spine.ts). */
      kind: BeatKindSchema.optional(),
      tape: TapePointerSchema
    })
    .strict(),
  z
    .object({
      sourcing: z.literal("narration"),
      claim: z.string().trim().min(1),
      exploration: z.boolean(),
      kind: BeatKindSchema.optional(),
      narration: NarrationAssignmentSchema
    })
    .strict()
]);
export type SourcedBeat = z.infer<typeof SourcedBeatSchema>;

export const SourcedSlotSchema = z
  .object({
    title: z.string().trim().min(1),
    beats: z.array(SourcedBeatSchema).min(1)
  })
  .strict();
export type SourcedSlot = z.infer<typeof SourcedSlotSchema>;

export const SourcedActSchema = z
  .object({
    title: z.string().trim().min(1),
    slots: z.array(SourcedSlotSchema).min(1)
  })
  .strict();
export type SourcedAct = z.infer<typeof SourcedActSchema>;

/** A tier-3 hit: a beat whose claim matches a catalogue item with no
 * transcript at all. §4.5: "It can be logged as a transcription-queue
 * candidate" — logged only, never acted on in this stage (no new
 * transcription pipeline is built here). */
export const TranscriptionQueueCandidateSchema = z
  .object({
    claim: z.string().trim().min(1),
    itemId: z.string().trim().min(1).optional(),
    showId: z.string().trim().min(1).optional(),
    reason: z.string().trim().min(1)
  })
  .strict();
export type TranscriptionQueueCandidate = z.infer<typeof TranscriptionQueueCandidateSchema>;

/** Which transcript a minted segment's anchors were authored against —
 * `data/segments.json`'s own `transcript_source` vocabulary, as
 * `tools/segments/merge-segments.mjs` (`TRANSCRIPT_SOURCES`) gates it. It is
 * provenance, not a choice: an anchor is verbatim with respect to exactly one
 * transcript. `publisher` is the archive body `tools/segments/fetch-transcripts.mjs`
 * fetched from the publisher's own transcript URL; `asr-local` is a body this
 * machine transcribed itself (`tools/transcribe/`). */
export const TranscriptSourceSchema = z.enum(["publisher", "asr-local"]);
export type TranscriptSource = z.infer<typeof TranscriptSourceSchema>;

/** A segment minted by the tier-2 path. NOT written to
 * `data/segments.json` by this module — that write path belongs to
 * `tools/segments/merge-segments.mjs` and its validator, which this
 * in-process generation stage does not call. Returned so a caller can
 * hand it to that existing merge path later; §4.6's structural
 * guarantee (numbers + quoted anchor text only) holds for it exactly as
 * it does for a tier-1 pointer.
 *
 * `why` and `transcriptSource` are here because the pool gate
 * (`merge-segments.mjs --check`) requires them on every row and only the
 * mint site knows them (F-78): the beat's claim is in hand exactly once, at
 * `sourceBeats.ts`'s `acceptCandidate`, and so is the cue provider that read
 * the body the anchors were cut from. The remaining two gate fields the row
 * needs — `dai_suspected` and `batch_id` — are NOT on the segment on purpose:
 * the DAI verdict belongs to the episode's `MintedSegmentSource` row (one
 * verdict, one place — `finalizeForay.ts`'s `mintedSegmentRow` reads it from
 * there and refuses to default it) and the batch id is the publish's, not the
 * mint's. A checkpoint written before these fields existed does not resume
 * (zod names the missing field); such a run's tape could not have been
 * published anyway. */
export const NewSegmentSchema = z
  .object({
    id: z.string().trim().min(1),
    itemId: z.string().trim().min(1),
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
    referenceDurationSec: z.number().positive(),
    startAnchor: z.string().trim().min(1),
    endAnchor: z.string().trim().min(1),
    confidence: z.enum(["high", "medium", "low"]),
    /** The pool's curator note, derived from the beat's claim by
     * `mintedSegmentCopy.ts`'s `whyFromClaim` (≤ 18 words, ASCII punctuation,
     * clamped at a word boundary). */
    why: z.string().trim().min(1),
    transcriptSource: TranscriptSourceSchema
  })
  .strict();
export type NewSegment = z.infer<typeof NewSegmentSchema>;

/**
 * One row of evidence for the `tapeRelevance` metric the veracity gate is built
 * on (fix plan WS-B): "share of tape anchors whose episode shares a taxonomy
 * family with the Foray's resolved topic, plus the list of anchors for human
 * spot-check".
 *
 * §4.5 is the only stage that knows all four of these things at once, so it
 * emits them rather than leaving a later stage to re-derive a join it cannot
 * see. Run 1 could not measure this at all — the number (5 of 22 anchors on
 * topic) had to be counted by hand from the narration prompts.
 */
export interface TapeRelevanceInput {
  /** Where the beat sits, so a failing anchor can be found by a human. */
  actIndex: number;
  slotIndex: number;
  beatIndex: number;
  /** Named to match WS-B's `TapeAnchorNote`, which carries the same two fields
   * for the same reason: a human spot-checking the list needs to see which
   * claim took which item. */
  claim: string;
  itemId: string;
  /** The anchor itself. */
  segmentId: string;
  tier: 1 | 2;
  /** Every taxonomy node this anchor resolved to — the segment's own `topic`
   * unioned with its show's `taxonomy_node_ids` (tier 1), or the show's nodes
   * (tier 2). The set the topic gate actually judged. */
  taxonomyNodeIds: string[];
  /** Those nodes' roots, and the field name/values WS-B's `TapeAnchorNote`
   * already uses, so its aggregation can read these rows unchanged. */
  families: string[];
  /** The Foray's resolved node and its root; null when sourcing ran without one. */
  forayTopic: string | null;
  forayFamily: string | null;
  /** Whether the anchor shares the Foray's taxonomy LINEAGE — `null` when
   * nothing could be established, which WS-B excludes from the metric's
   * numerator AND denominator. "Unknown" is never "fine". */
  onTopic: boolean | null;
  /**
   * The episode §4.3 wrote this beat's claim from, when it wrote it from tape at
   * all (WS-L, F-63) — `null` for an unseeded beat, which is every beat of every
   * Foray built before the research map quoted windows.
   *
   * Optional so nothing that constructs one of these rows had to change.
   */
  seededEpisode?: string | null;
  /**
   * Whether the tape this beat took came from that episode: the seed's window
   * WON, rather than being beaten by something the text index ranked or refused
   * by the relevance floor.
   *
   * This is the number WS-L is measured by. "Seeded from tape" is a claim about
   * the spine; "the seed won" is a claim about the finished Foray, and the two
   * come apart exactly when the spine wrote a beat the tape does not support —
   * which is the failure mode this whole workstream exists to make visible
   * rather than to hide.
   */
  seedWindowWon?: boolean;
  /**
   * WHICH FLOOR ADMITTED THE SEED WINDOW (F-72). `"share-only"` when the
   * window the beat took is the seed's own and it cleared
   * `TIER2_WINDOW_MIN_SHARE` WITHOUT the rare-word count — the case F-72 is
   * about, where the spine quoted a passage and wrote a claim whose
   * distinctiveness that passage carries in one or two words rather than
   * three. Absent when the seed window would have cleared the searching floor
   * anyway, and absent for every window found by searching.
   *
   * So the count of these rows is the count of beats that have tape ONLY
   * because of F-72 — the number the rule is answerable for, kept separate
   * from the number of seeded beats, which says nothing about it.
   */
  seedFloor?: "share-only";
  /**
   * D5's triple clause is what chose this segment's LENGTH (F-80): the ladder
   * rung's own cut of the window would have made the last three placed
   * durations a uniform triple (`check-forays.mjs`'s "three consecutive
   * durations within +/-20 % of each other"), and a different cut of the same
   * window — a different ladder rung, or another cue-boundary length the
   * growth rule reaches — escaped the band and was placed instead. Absent
   * whenever the rung's cut escaped by itself, and always absent for tier 1
   * (a pool segment's length is a curator's, and one that would make the
   * triple is passed over rather than re-cut).
   *
   * Counting these rows counts the placements the rule DECIDED, which is the
   * number to watch: a run where it fires often is a run whose ladder and
   * passages are producing lengths the rule keeps having to correct.
   */
  lengthGate?: "d5-triple";
  /**
   * Tier 2's window was cut to a start the committed pool already holds a
   * segment at, and the POOL'S cut was placed under the pool's own id instead
   * of a minted sibling (F-84). The row reports `tier: 1` — what plays is a
   * `data/segments.json` row and nothing was minted — and this field says the
   * archive search, not the claim-overlap bar, is what found it. Counting these
   * rows counts the beats the previous Forays' tape served again.
   */
  poolCut?: "reused";
}

/**
 * WHY A BEAT GOT NO TAPE (finding F-49).
 *
 * Run 2 finished with zero tape beats out of 35 and the only evidence of what
 * had happened was one sentence repeated six times — "No tape found anywhere in
 * the §4.5 search order" — while the research map for the same prompt reported
 * *Ai: 761 items* as strong tape and the machine held 337 *Practical AI*
 * transcripts. That sentence cannot distinguish "the pool has nothing about
 * AI", "the best episode was two title tokens short", "the taxonomy gate
 * refused it" and "the transcript body was not on this machine" — four
 * different faults with four different fixes. Every threshold in §4.5 was
 * therefore tuned by argument rather than against data.
 *
 * These rows are that data: for every beat that ended up narrated, the best
 * candidate each tier actually saw, the score it actually got, and the gate
 * that actually rejected it.
 */

/** Which tier-1 gate turned down the best-scoring pool segment.
 *
 *   - `no-candidates`  — no segment in the pool shares a single content word.
 *   - `threshold`      — the best candidate scored below its own bar
 *                        (`requiredOverlapFor`: a count for a metadata
 *                        haystack, claim coverage for a transcript window).
 *   - `topic-lineage`  — it cleared the bar but is in another taxonomy family.
 *   - `exhausted`      — it cleared everything, but another beat of this Foray
 *                        already played it (F-29's "exhaustion of the one
 *                        relevant episode").
 *   - `m4-share`       — its episode already holds its quarter of the Foray.
 *   - `m3-order`       — it sits earlier in an episode already joined later.
 *
 * And the four D-tier length rules F-73 added, which both tiers now ask at the
 * point where a candidate's duration is known (`DurationGate` in
 * `sourceBeats.ts`; `docs/curation/narration-craft.md` §0 via
 * `tools/foray/check-forays.mjs`):
 *
 *   - `d2-short-run`   — it is under 60 s and so is the segment before it, which
 *                        is the run D2 only permits if a 150 s segment follows —
 *                        something sourcing cannot promise, so it never starts
 *                        the run.
 *   - `d3-mean`        — taking it would drop the Foray's running mean segment
 *                        duration under D3's 90 s floor.
 *   - `d5-triple`      — it and the two segments before it would be within
 *                        +/-20 % of each other, D5's uniform triple, by
 *                        `check-forays.mjs`'s own arithmetic (`d5Triple.ts`).
 *                        A rule, not a preference, since F-80: for a pool
 *                        segment the length is fixed and the candidate is
 *                        passed over; for a tier-2 window every other length
 *                        the window can be cut to is tried first, and the gate
 *                        is reported only when none escapes the band. (Spelled
 *                        `d5-uniform` in traces written by #571–#620.)
 *   - `m4-runtime`     — its episode already holds M4's quarter of the Foray's
 *                        tape SECONDS (the clause #569 left to the checker).
 *                        Never asked about an episode's first segment. */
export type Tier1Gate =
  | "no-candidates"
  | "threshold"
  | "topic-lineage"
  | "exhausted"
  | "m4-share"
  | "m3-order"
  | "d2-short-run"
  | "d3-mean"
  | "d5-triple"
  | "m4-runtime";

/** Which tier-2 gate turned down the best-scoring archive episode.
 *
 *   - `title-tokens`   — no episode reached `TIER2_MATCH_THRESHOLD` on its own
 *                        title (the show title can add one point, never carry
 *                        the match). This is the F-06 recall wall: tier 2 reads
 *                        titles, not transcript text.
 *   - `lineage`        — the best-scoring episode's show is in another family.
 *   - `no-body`        — the episode matched, but no transcript body for it is
 *                        on this machine, so no anchor could be located.
 *   - `window-overlap` — the body is here and was searched, but no window of it
 *                        carries enough of the claim to be about it (F-24, and
 *                        F-61's relevance floor: distinct claim content words
 *                        spoken in one stretch of tape, and their share of the
 *                        claim).
 *   - `no-anchor`      — a window IS about the claim, but neither of its
 *                        boundary cues yields a quotable 4-8 word phrase to
 *                        anchor with. Structural (a word-level transcript, a
 *                        cue of pure function words), never a judgement.
 *   - `no-audio-source` — everything matched and an anchor was found, but no
 *                        honest `data/segment-sources.json` row can be written
 *                        for the episode, so nothing could ever play it (see
 *                        `audioSourceLookup.ts`).
 *   - `m4-share`       — the episode already supplies as much of this Foray as
 *                        M4's quarter allows (F-70). Same name and same meaning
 *                        as the tier-1 gate above; tier 2 now keeps the same
 *                        ledger, so the two tiers refuse for the same reason.
 *   - `m3-order`       — the window tier 2 would mint sits EARLIER in an episode
 *                        this Foray has already joined later, which is M3's
 *                        "plays at N s after a later segment from the same
 *                        episode" (F-70). Decided on the cut span's own start,
 *                        so it is the minted segment's real time, not a guess. */
export type Tier2Gate =
  /* WS-H (F-06): the text index ran and no lineage-admissible episode in the
     archive was worth opening for this claim — the search reached the
     transcripts' own words and they had nothing. Distinct from `title-tokens`,
     which means no text search ran at all (a checkout with no transcript
     bodies) and the title bar was the only thing that could decide. */
  | "text-index:no-candidate"
  | "title-tokens"
  | "lineage"
  | "no-body"
  | "no-anchor"
  | "window-overlap"
  | "no-audio-source"
  /* F-70: the two Foray-wide assembly rules, now asked by BOTH tiers. Named
     identically to their `Tier1Gate` twins on purpose — one rule, one name,
     whichever tier found the tape. */
  | "m4-share"
  | "m3-order"
  /* F-73: the four D-tier LENGTH rules, likewise asked by both tiers and named
     the same in both — documented once, on `Tier1Gate` above. Tier 2 asks them on
     the cut span, which is the first point at which a minted segment has a real
     duration. */
  | "d2-short-run"
  | "d3-mean"
  | "d5-triple"
  | "m4-runtime"
  /* F-84: the window's cut begins where a COMMITTED pool segment (or one this
     run already minted) begins, so the pool's cut is what would play there —
     and the Foray's ledger refused that cut (already played, M3, a length
     rule). A sibling id at the same start is never minted instead. */
  | "pool-cut"
  /* F-87 (#315): the window's cut would END past the episode's feed-declared
     duration (`TranscriptDigestEntry.feed_duration_sec`). Not clamped — a
     transcript whose timeline overruns the audio it describes is exactly the
     untrustworthy timeline #315 describes, and a shorter cut of it would be a
     plausible-looking segment nobody has reason to re-examine. Run 7 attempt 3
     minted `…bp-texas-city#2292` ending at 2375.72 s on a 2071 s episode and
     `check-forays.mjs` refused act 1's partial after every act was narrated. */
  | "past-duration";

export interface Tier1TraceRow {
  /** The best-scoring pool segment, whatever gate then refused it. */
  bestSegmentId: string | null;
  bestItemId: string | null;
  score: number;
  /** The bar THAT candidate had to clear — see `requiredOverlapFor`. */
  requiredScore: number;
  /** Which haystack the score was measured against (F-06/F-29). */
  matchedIn: "transcript" | "metadata" | null;
  gate: Tier1Gate;
  /* G-24 R2: for a transcript-window candidate, the same two numbers tier 2's
     window faces — the idf-weighted share of the claim the segment speaks and
     the claim's rare words it speaks (`segmentPoolLookup.ts`, `tier1BarClears`).
     A `threshold` row can now mean "the count bar" or "the weighted floor", and
     these say which. Absent for a metadata candidate, which faces neither. */
  windowWeightedShare?: number;
  windowDistinctiveTerms?: string[];
}

export interface Tier2TraceRow {
  /** The best-scoring archive episode, whatever gate then refused it. */
  bestShowId: string | null;
  bestEpisodeTitle: string | null;
  score: number;
  requiredScore: number;
  gate: Tier2Gate;
  /* F-61: what the WINDOW search saw. The old pair of fields here
     (`anchorContentWords`/`beyondAnchorOverlap`) measured a verbatim run of the
     claim's own words and its neighbourhood; there is no such run any more, and
     the question a person asks of a refused beat is which of the claim's words
     the tape said and how much of the claim that is. */

  /** The claim's content words spoken inside the best window of that episode's
   * tape, in the claim's own order. */
  windowMatchedTerms?: string[];
  /** Those of them the corpus considers rare for this claim — the subset the
   * `TIER2_WINDOW_MIN_TERMS` count is measured on. */
  windowDistinctiveTerms?: string[];
  /** Those words as a plain share of the claim's content words. */
  windowTermShare?: number;
  /** And weighted by how rare each word is in the corpus the candidate came
   * from — the number the relevance floor (`TIER2_WINDOW_MIN_SHARE`) is argued
   * against, and the one that tells "says the claim's subject" from "shares the
   * trade's vocabulary" (F-33). */
  windowWeightedShare?: number;
  /** Where that window is in the episode, so a human can go and listen. */
  windowStartSec?: number;
  windowEndSec?: number;
  /** The anchors minted from the tape at the chosen window's edges, present
   * when the search got that far (a beat refused later, at the audio-source
   * check, still shows what it would have quoted). */
  startAnchor?: string;
  endAnchor?: string;
  /** F-87: where the cut would have ENDED, and the episode's feed-declared
   * duration — both present on a `past-duration` row so the refusal can be
   * read as the comparison it is (run 7: 2375.72 s past 2071 s). `spanEndSec`
   * is set whenever the search cut a span; `feedDurationSec` whenever the
   * digest declared one. */
  spanEndSec?: number;
  feedDurationSec?: number;
  /* WS-H (F-06/F-49): what the TEXT search saw, so a run can be argued with.
     Without these, a trace row saying `no-anchor` cannot be told from one that
     never searched the text at all — which is the confusion that let run 2's
     zero-tape result look like an empty archive rather than a title bar. */

  /** How the reported episode was found: the transcript-text index, or the
   * title-metadata fallback the search keeps behind it. */
  foundBy?: "text-index" | "title";
  /** The episode's BM25 score over its own cue text. Absent for a title find. */
  textScore?: number;
  /** Its 0-based rank in the text search. */
  textRank?: number;
  /** How many distinct claim content words are spoken in it at all. */
  textMatchedTerms?: number;
  /** How many episodes tier 2 opened for this beat before giving up. */
  candidatesConsidered?: number;
  /* WS-L (F-63): the seed, and what became of it. Present only for a beat §4.3
     wrote from a quoted transcript window. */

  /** The episode the spine seeded this beat from. Tier 2 opens it FIRST, before
   * anything the text index ranked. */
  seededEpisode?: string;
  /** Whether the seeded episode's window is the one that won. Always false in a
   * row of this array — a trace row exists only for a beat that ended up
   * narrated — and the field is here so the two sides of the sourcing evidence
   * (`tapeRelevance` and `sourcingTrace`) answer the same question in the same
   * words. */
  seedWindowWon?: boolean;
  /** Which floor admitted the reported window (F-72) — see
   * `TapeRelevanceInput.seedFloor`. Present here only when a seed window the
   * share-only floor ADMITTED was then refused by a later gate (`no-anchor`,
   * `m3-order`, `no-audio-source`), so the row does not read as though the
   * searching floor had passed it. Never set on a `window-overlap` row: a
   * refused window was admitted by no floor. */
  seedFloor?: "share-only";
  /**
   * THE SEED'S OWN GATE, ALONGSIDE THE FURTHEST (G-24 R3; tape-yield brief §4
   * cause 3, §6). `gate` above names the candidate that got FURTHEST down the
   * walk, and for a seeded beat that is very often not the seed: on attempt 6
   * beat 1/0/0's seed window scored 0.746 and was refused by M4's share cap,
   * and the row said `window-overlap` at 0.27 on a different episode — "the
   * reasons for collapsing seem weak" was the founder reading the wrong reason.
   * This is the gate that refused the seed window itself, whatever `gate` says.
   * Present on every seeded beat that ended up narrated.
   */
  seedGate?: Tier2Gate;
  /** And the seed window's own weighted share, when the body was opened and the
   * window scored — so a reader can see a 0.746 refused by `m4-share` for what
   * it is. Absent when the seeded episode had no body on this machine. */
  seedWindowWeightedShare?: number;
}

/** One narration-degraded beat's account of itself. */
export interface SourcingTrace {
  actIndex: number;
  slotIndex: number;
  beatIndex: number;
  claim: string;
  /** `skipped:argument` — §4.4 tagged the beat an argument, so no search ran at
   * all and both tiers are null. `no-tape` — the search ran and both tiers came
   * back empty-handed; the rows say where each stopped. */
  outcome: "skipped:argument" | "no-tape";
  tier1: Tier1TraceRow | null;
  tier2: Tier2TraceRow | null;
}

export interface SourceBeatsResult {
  acts: SourcedAct[];
  /** Every NEW segment tier 2 produced this run — see `NewSegmentSchema`'s
   * doc comment on why these are not written to disk here. */
  newSegments: NewSegment[];
  transcriptionQueueCandidates: TranscriptionQueueCandidate[];
  /** One row per TAPE-sourced beat, in Foray order — see `TapeRelevanceInput`. */
  tapeRelevance: TapeRelevanceInput[];
  /** One row per NARRATION-degraded beat, in Foray order — see `SourcingTrace`.
   * The two arrays partition the Foray's beats between them. */
  sourcingTrace: SourcingTrace[];
  /** The `data/segment-sources.json` row for every episode `newSegments` was
   * minted from, deduplicated by item id — without which the checker cannot
   * resolve the audio and the Foray fails §4.9 (see `audioSourceLookup.ts`).
   * Empty when the caller supplied no resolver, which is every test that
   * predates one. */
  newSegmentSources: MintedSegmentSource[];
}

export interface SourcingValidationIssue {
  code: "beat-count-changed" | "beat-claim-changed" | "slot-count-changed" | "act-count-changed";
  message: string;
}
export interface SourcingValidationResult {
  valid: boolean;
  issues: SourcingValidationIssue[];
}

/**
 * Structural check for §4.5's non-negotiable guardrail: the beat list
 * going IN (from `deepenedActs`) must equal the beat list coming OUT
 * (from `sourced`) — same count, same claims, in the same order. Only
 * the per-beat SOURCING decision may differ. Mirrors
 * `spine.ts`'s `validateDeepenedAct`.
 */
export function validateSourcing(deepenedActs: DeepenedAct[], sourced: SourcedAct[]): SourcingValidationResult {
  const issues: SourcingValidationIssue[] = [];

  if (deepenedActs.length !== sourced.length) {
    issues.push({
      code: "act-count-changed",
      message: `Sourcing changed act count from ${deepenedActs.length} to ${sourced.length} — §4.5 only decides HOW a beat is sourced, never whether it exists`
    });
    return { valid: false, issues };
  }

  for (let a = 0; a < deepenedActs.length; a++) {
    const originalAct = deepenedActs[a]!;
    const sourcedAct = sourced[a]!;
    if (originalAct.slots.length !== sourcedAct.slots.length) {
      issues.push({
        code: "slot-count-changed",
        message: `Act "${originalAct.title}": slot count changed from ${originalAct.slots.length} to ${sourcedAct.slots.length}`
      });
      continue;
    }
    for (let s = 0; s < originalAct.slots.length; s++) {
      const originalSlot = originalAct.slots[s]!;
      const sourcedSlot = sourcedAct.slots[s]!;
      const originalBeats: Beat[] = originalSlot.beats;
      if (originalBeats.length !== sourcedSlot.beats.length) {
        issues.push({
          code: "beat-count-changed",
          message: `Act "${originalAct.title}" slot "${originalSlot.title}": beat count changed from ${originalBeats.length} to ${sourcedSlot.beats.length}`
        });
        continue;
      }
      for (let b = 0; b < originalBeats.length; b++) {
        if (originalBeats[b]!.claim !== sourcedSlot.beats[b]!.claim) {
          issues.push({
            code: "beat-claim-changed",
            message: `Act "${originalAct.title}" slot "${originalSlot.title}" beat ${b}: claim changed from "${originalBeats[b]!.claim}" to "${sourcedSlot.beats[b]!.claim}"`
          });
        }
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

/** Flattened helper, mirroring `spine.ts`'s `allBeats`. */
export function allSourcedBeats(acts: SourcedAct[]): SourcedBeat[] {
  return acts.flatMap((act) => act.slots.flatMap((slot) => slot.beats));
}
