import { z } from "zod";
import { type Beat, type DeepenedAct } from "./spine";

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
  z.object({ sourcing: z.literal("tape"), claim: z.string().trim().min(1), exploration: z.boolean(), tape: TapePointerSchema }).strict(),
  z
    .object({ sourcing: z.literal("narration"), claim: z.string().trim().min(1), exploration: z.boolean(), narration: NarrationAssignmentSchema })
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

/** A segment minted by the tier-2 path. NOT written to
 * `data/segments.json` by this module — that write path belongs to
 * `tools/segments/merge-segments.mjs` and its validator, which this
 * in-process generation stage does not call. Returned so a caller can
 * hand it to that existing merge path later; §4.6's structural
 * guarantee (numbers + quoted anchor text only) holds for it exactly as
 * it does for a tier-1 pointer. */
export const NewSegmentSchema = z
  .object({
    id: z.string().trim().min(1),
    itemId: z.string().trim().min(1),
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
    referenceDurationSec: z.number().positive(),
    startAnchor: z.string().trim().min(1),
    endAnchor: z.string().trim().min(1),
    confidence: z.enum(["high", "medium", "low"])
  })
  .strict();
export type NewSegment = z.infer<typeof NewSegmentSchema>;

export interface SourceBeatsResult {
  acts: SourcedAct[];
  /** Every NEW segment tier 2 produced this run — see `NewSegmentSchema`'s
   * doc comment on why these are not written to disk here. */
  newSegments: NewSegment[];
  transcriptionQueueCandidates: TranscriptionQueueCandidate[];
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
