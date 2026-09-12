import { z } from "zod";
import { SourceSchema } from "./narration";

/**
 * §4.8 output types (docs/curation/generation-architecture.md §4.8): the
 * within-act-stitched, then cross-act-stitched, ordered item sequence for
 * one Foray, plus the coverage bookkeeping §4.8's rule 4 ("coverage is
 * checked before flow") requires.
 *
 * `StitchedItem` is deliberately shaped close to (but not identical to)
 * the `data/forays.json` item shape `tools/foray/check-forays.mjs`
 * validates — see `forayItems.ts` for the final field-for-field mapping.
 * It is kept as its own internal type, rather than authoring directly
 * against the forays.json shape, for one reason: this stage's items carry
 * INTERNAL bookkeeping (`beatIndex`, `itemId` for tape items, the
 * `NarratedBeat`'s `sources`/`verified`/`pronunciationHints`) that
 * `forays.json` must never see (per §7 item 5 / this stage's own task
 * brief: "sources/verified/pronunciationHints are internal-only, NOT
 * written to forays.json"). Mixing the two shapes would make it too easy
 * for an internal field to leak into a publish write by accident.
 *
 * F-103: THAT SENTENCE WAS ALREADY FALSE WHEN IT WAS WRITTEN, and the way
 * it was false is what this change fixes. `StitchedNarrationItem` below
 * never carried `sources` or `verified` at all — `stitchAct.ts` copied
 * `mode` and `script` off the `NarratedBeat` and nothing else, and the
 * schema is `.strict()`, so the fields could not have arrived even by
 * accident. The leak guard `forayItems.ts` runs against its own OUTPUT
 * (`assertNoInternalFieldsLeaked`) was therefore guarding a leak that was
 * structurally impossible: the provenance was gone one hop earlier than
 * the comment claiming to protect it.
 *
 * It is carried now, because the reader is owed it. The writer knows what
 * each page rests on (writeAct.ts: the verifier answers `restsOn`, which
 * `sourcesForRest` resolves into `Source[]`), and a listener reading a
 * narrated beat's transcript should be able to see what it rests on. So
 * `sources` and `verified` ride the stitched item, and `forayItems.ts` —
 * still the ONE place that decides what reaches `data/forays.json` —
 * derives the small published `cites` shape from them. The leak guard
 * stays, and for the first time it guards something real: `sources` and
 * `verified` themselves must still never appear on a published item, only
 * the derived `cites`.
 */

export const StitchedTapeItemSchema = z
  .object({
    kind: z.literal("tape"),
    /** Index of the originating beat within its act's FLATTENED beat list
     * (§4.8 rule 4's own audit key — see `SourcedBeat`/coverage below). */
    beatIndex: z.number().int().nonnegative(),
    slotTitle: z.string().trim().min(1),
    segmentId: z.string().trim().min(1),
    itemId: z.string().trim().min(1),
    startSec: z.number().nonnegative(),
    endSec: z.number().positive(),
    label: z.string().trim().min(1).optional()
  })
  .strict();
export type StitchedTapeItem = z.infer<typeof StitchedTapeItemSchema>;

export const StitchedNarrationKindSchema = z.enum([
  /** A narrated beat that IS a spine beat (Patch/Carry, from §4.5, now
   * written by §4.7). */
  "beat",
  /** An act's own introduction/exit (from `DeepenedAct.introduction` /
   * `.exit`) — not itself a spine beat, so it carries no `beatIndex`. */
  "seam"
]);
export type StitchedNarrationKind = z.infer<typeof StitchedNarrationKindSchema>;

export const StitchedNarrationItemSchema = z
  .object({
    kind: z.literal("narration"),
    narrationKind: StitchedNarrationKindSchema,
    /** Present only when `narrationKind === "beat"` — the flattened beat
     * index this narration item covers coverage for. */
    beatIndex: z.number().int().nonnegative().optional(),
    slotTitle: z.string().trim().min(1).optional(),
    mode: z.enum(["Hinge", "Frame", "Marker", "Correction", "Patch", "Carry", "Intro"]),
    script: z.string().trim().min(1),
    id: z.string().trim().min(1),
    /* F-103's two additions — the page's provenance, carried from the
       `NarratedBeat` `stitchAct.ts` reads `mode`/`script` off. Both
       OPTIONAL, and the pair below is the reason:

       `verified` absent must mean the same thing as `verified: false`,
       because a hand-built `StitchedNarrationItem` (every fixture in
       `backend/test`, and `stitchForay.ts`'s continuity rewrites) says
       nothing about verification and must not be read as claiming any.
       `forayItems.ts` publishes citations ONLY for `verified === true`,
       so an item that never learned its verification state publishes
       none — the honest default, and the failure-safe one.

       `sources` is the verifier's answer resolved (`sourcesForRest`),
       one entry per claim, and may legitimately be empty: a pure
       handoff asserts nothing, and a page verified by SYNTHESIS (F-88)
       rests on the Foray's own earlier pages rather than on any
       external document, so its `restsOn` resolves to page ids and its
       `sources` to nothing. Both publish no citations, which is correct
       — there is no outside thing for a reader to go and check. */
    sources: z.array(SourceSchema).optional(),
    verified: z.boolean().optional()
  })
  .strict();
export type StitchedNarrationItem = z.infer<typeof StitchedNarrationItemSchema>;

export const StitchedJingleItemSchema = z
  .object({
    kind: z.literal("jingle"),
    /** Why this jingle got inserted — "cut" (rule 2, a real change of
     * tape with nothing bridging it) or "cadence" (rule 3, a same-episode
     * bridge that would otherwise be silent, inserted anyway because the
     * measured texture cadence elapsed). Internal bookkeeping only, not
     * written to forays.json. */
    reason: z.enum(["cut", "cadence"]),
    id: z.string().trim().min(1).optional()
  })
  .strict();
export type StitchedJingleItem = z.infer<typeof StitchedJingleItemSchema>;

export const StitchedItemSchema = z.discriminatedUnion("kind", [StitchedTapeItemSchema, StitchedNarrationItemSchema, StitchedJingleItemSchema]);
export type StitchedItem = z.infer<typeof StitchedItemSchema>;

/**
 * §4.8 rule 4: "Coverage is checked before flow. Every beat in the spine
 * is either present or explicitly dropped with a reason. A silently
 * missing beat is the failure mode that makes a Foray feel like it was
 * about nothing."
 *
 * One entry per beat in the act's flattened beat list, always — a beat
 * with neither an item reference nor a recorded drop reason is what
 * `validateActCoverage` (stitchAct.ts) treats as a hard validation
 * failure, mirroring `validateDeepenedAct`'s `{valid, issues}` shape
 * (spine.ts) rather than throwing.
 */
export const CoverageEntrySchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("present"), beatIndex: z.number().int().nonnegative(), claim: z.string() }).strict(),
  z.object({ status: z.literal("dropped"), beatIndex: z.number().int().nonnegative(), claim: z.string(), reason: z.string().trim().min(1) }).strict()
]);
export type CoverageEntry = z.infer<typeof CoverageEntrySchema>;

export interface ActCoverageReport {
  entries: CoverageEntry[];
}

export interface ActCoverageValidationIssue {
  code: "beat-not-covered";
  beatIndex: number;
  message: string;
}

export interface ActCoverageValidationResult {
  valid: boolean;
  issues: ActCoverageValidationIssue[];
}

/**
 * §4.8 rule 4's hard gate: every entry in the coverage report must be
 * either `present` or `dropped` (both are legal — see `CoverageEntrySchema`
 * above). Anything else — a beat index missing an entry entirely — is
 * unreachable by construction from `stitchAct` (which always emits one
 * entry per input beat) but checked here anyway, matching
 * `validateSourcing`'s belt-and-suspenders style in tapeSourcing.ts.
 */
export function validateActCoverage(report: ActCoverageReport, totalBeats: number): ActCoverageValidationResult {
  const issues: ActCoverageValidationIssue[] = [];
  const seen = new Set(report.entries.map((e) => e.beatIndex));
  for (let i = 0; i < totalBeats; i++) {
    if (!seen.has(i)) {
      issues.push({ code: "beat-not-covered", beatIndex: i, message: `Beat ${i} has no coverage entry at all — neither present nor explicitly dropped with a reason` });
    }
  }
  return { valid: issues.length === 0, issues };
}

export interface StitchedAct {
  items: StitchedItem[];
  coverage: ActCoverageReport;
}
