import type { DeepenedAct } from "../types/spine";
import { validateActCoverage, type StitchedItem } from "../types/stitching";
import type { WrittenAct } from "./writeNarration";
import { countActBeats, stitchAct } from "./stitchAct";
import { smoothActs, type SmoothActsOptions } from "./smoothSeam";
import { toForayItems, assertNoInternalFieldsLeaked, type ForayItem } from "./forayItems";
import type { ContinuityBuildContext } from "./ContinuityBuilder";

/**
 * §4.8 top-level orchestrator (docs/curation/generation-architecture.md
 * §4.8): the single entry point a §4.9 caller uses to turn §4.4's
 * `DeepenedAct[]` (introductions/exits) plus §4.7's `WrittenAct[]`
 * (written-and-verified pages, one array element per act, same order)
 * into the final ordered `ForayItem[]` ready to become
 * `data/forays.json`'s `items` array (minus the disclosure item, which
 * §4.7's `disclosureNarratedBeat`/`disclosureTemplate` already produce
 * and §4.9 is responsible for prepending — this stage stitches the
 * BODY of the Foray, not that fixed opening beat).
 *
 * THREE STEPS, IN ORDER, MATCHING THIS STAGE'S TASK BRIEF EXACTLY:
 *
 *   (a) WITHIN-ACT stitching, per act, via `stitchAct` — deterministic
 *       (see that module's doc comment for why no LLM/Builder is used
 *       here, mirroring PR #408's precedent).
 *   (b) CROSS-ACT continuity, at every act boundary, via the ONE
 *       `ContinuityBuilder` (§5: "1 continuity agent... the only place
 *       no single act agent has context"), forward-only (§6.2) — see
 *       `smoothSeam.ts`. This step only ever touches `introduction`
 *       strings on `DeepenedAct[]`; it happens BEFORE within-act
 *       stitching writes the act's OWN introduction into the item
 *       sequence (see below), so a smoothed introduction reaches the
 *       final assembly rather than the original.
 *   (c) MAPPING every act's stitched items, in act order, into the
 *       `data/forays.json`-shaped `ForayItem[]` (`forayItems.ts`) —
 *       including a `seam` narration item at the START of every act
 *       after the first, carrying that act's (possibly continuity-
 *       smoothed) `introduction`, and at the END of every act,
 *       carrying its own `exit` (never touched by continuity — see
 *       `smoothSeam.ts`'s doc comment on why only `introduction` is
 *       ever replaced).
 *
 * COVERAGE IS CHECKED PER ACT, BEFORE ASSEMBLY (§4.8 rule 4): a single
 * act failing `validateActCoverage` fails the WHOLE `stitchForay` call
 * — a Foray missing coverage for one of its own beats is not a partial
 * success, mirroring `deepenActs.ts`'s "a deepened act is not optional
 * content" reasoning at this later stage.
 */
export class ActCoverageFailedError extends Error {
  constructor(
    public readonly actIndex: number,
    public readonly actTitle: string,
    public readonly issues: string[]
  ) {
    super(`Act ${actIndex + 1} ("${actTitle}") failed coverage validation: ${issues.join("; ")}`);
    this.name = "ActCoverageFailedError";
  }
}

export interface StitchForayOptions {
  continuity: SmoothActsOptions;
}

export interface StitchForayResult {
  items: ForayItem[];
}

/**
 * `deepenedActs` and `writtenActs` MUST be the same length, same order,
 * one-to-one (act N's `DeepenedAct` describes the same act as act N's
 * `WrittenAct`) — this is the caller's existing invariant from
 * `deepenActs.ts`/`writeNarration.ts` (both iterate `spine.acts` in the
 * same order and never reorder), checked here defensively rather than
 * re-derived.
 */
export async function stitchForay(deepenedActs: DeepenedAct[], writtenActs: WrittenAct[], options: StitchForayOptions, ctx: ContinuityBuildContext): Promise<StitchForayResult> {
  if (deepenedActs.length !== writtenActs.length) {
    throw new Error(`stitchForay: deepenedActs (${deepenedActs.length}) and writtenActs (${writtenActs.length}) must be the same length, one per act`);
  }

  // (b) Cross-act continuity FIRST — see module doc comment for why the
  // smoothed introduction must exist before within-act stitching's
  // per-act item assembly reads it.
  const smoothedActs = await smoothActs(deepenedActs, options.continuity, ctx);

  const allStitchedItems: StitchedItem[] = [];
  for (let i = 0; i < writtenActs.length; i++) {
    const deepened = smoothedActs[i]!;
    const written = writtenActs[i]!;
    const actLabel = `act-${i + 1}`;

    // (a) Within-act deterministic stitching.
    const stitched = stitchAct(written, actLabel);

    const totalBeats = countActBeats(written);
    const coverageResult = validateActCoverage(stitched.coverage, totalBeats);
    if (!coverageResult.valid) {
      throw new ActCoverageFailedError(
        i,
        deepened.title,
        coverageResult.issues.map((issue) => issue.message)
      );
    }

    // (c, partial) Seam narration around the act's own body: the act's
    // (possibly smoothed) introduction opens it, its own exit closes it
    // — mirroring `disclosureNarratedBeat`'s "seam" role but for a
    // whole-act boundary rather than the Foray's own opening.
    allStitchedItems.push({
      kind: "narration",
      narrationKind: "seam",
      slotTitle: deepened.slots[0]?.title,
      mode: "Frame",
      script: deepened.introduction,
      id: `${actLabel}-introduction`
    });
    allStitchedItems.push(...stitched.items);
    allStitchedItems.push({
      kind: "narration",
      narrationKind: "seam",
      slotTitle: deepened.slots[deepened.slots.length - 1]?.title,
      mode: "Frame",
      script: deepened.exit,
      id: `${actLabel}-exit`
    });
  }

  // (c) Final mapping into the forays.json-shaped item list.
  const items = toForayItems(allStitchedItems);
  assertNoInternalFieldsLeaked(items);

  return { items };
}
