import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape } from "../types/research";
import { SpineSchema, validateSpine, type DurationTier, type Spine, type SpineValidationResult } from "../types/spine";
import type { SpineBuildContext, SpineBuilder } from "./SpineBuilder";

/**
 * §4.3 end to end (docs/curation/generation-architecture.md §4.3), taking
 * §4.1's `IntentUnderstanding` and §4.2's `ResearchShape` as input,
 * building the spine in a SINGLE call to one `SpineBuilder` (§5: "1,
 * always" — no fan-out, no per-act calls at this stage), then validating
 * the result against §3's shape budgets, §4.3's claim-shape requirement,
 * and the ~30% exploration floor before returning it.
 *
 * THROWS on an invalid spine rather than returning a partially-valid one.
 * §3 is explicit that a spine overshooting its budget by 40% "is a
 * defect," and §4.3 says the highest-leverage artefact in the pipeline
 * must not be under-scoped in favor of speed — silently accepting a
 * broken spine here corrupts every downstream stage (§4.4 onward), so
 * this function fails loudly instead. The caller gets the full
 * `SpineValidationResult` on the thrown error for diagnostics.
 */
export class InvalidSpineError extends Error {
  constructor(public readonly validation: SpineValidationResult) {
    super(`Spine failed validation: ${validation.issues.map((i) => i.message).join("; ")}`);
    this.name = "InvalidSpineError";
  }
}

export async function buildSpine(
  intent: IntentUnderstanding,
  researchShape: ResearchShape,
  duration: DurationTier,
  builder: SpineBuilder,
  ctx: SpineBuildContext
): Promise<Spine> {
  const rawSpine = await builder.buildSpine(intent, researchShape, duration, ctx);

  // Schema-validate shape first (catches a builder that returns malformed
  // structure, e.g. a per-act voice field slipping in) before the
  // content-level checks in validateSpine.
  const spine = SpineSchema.parse(rawSpine);

  const validation = validateSpine(spine);
  if (!validation.valid) {
    throw new InvalidSpineError(validation);
  }

  return spine;
}
