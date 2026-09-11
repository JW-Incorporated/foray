import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape } from "../types/research";
import { SpineSchema, validateSpine, type DurationTier, type Spine, type SpineValidationResult } from "../types/spine";
import { checkSpineStructure, InvalidSpineStructureError } from "./spineStructure";
import type { SpineBuildContext, SpineBuilder, SpineRevisionRequest } from "./SpineBuilder";

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

/* ────────────────────────────────────────────────────────────────────────────
   F-86: one re-ask before the structural gate fails the run.
   ──────────────────────────────────────────────────────────────────────────── */

/**
 * How many times the builder is re-asked when its reply fails the structural
 * gate (`spineStructure.ts`, F-13) before the run fails. Generation run 7
 * attempt 2 (2026-09-11, engineering disasters): after understand and
 * research-shape had run, the spine's act 2 carried one beat whose claim was
 * two sentences — "The epoxy that held the Big Dig's ceiling panels wasn't
 * chosen recklessly; it passed the tests it was given. The failure…" — and the
 * gate, correctly, refused it. The driver recorded `error` and ended the run
 * (G-30's resume loop rightly treats a gate refusal as non-transient), so one
 * Opus call was lost to a reply a single sentence would have fixed, on a run
 * that costs 70-odd calls.
 *
 * The gate is NOT loosened — one sentence per claim is what narration craft
 * downstream depends on (F-41). What changes is what happens after it fires:
 * the builder is asked once more, with the exact violations appended as a
 * "fix only these" instruction and the previous reply kept in the
 * conversation, so the model changes the beats named and nothing else. Then
 * the gate runs again, and only then does the run fail — with the same F-13
 * message it failed with before.
 *
 * `0` restores the pre-F-86 behaviour exactly: the first refusal fails the run.
 * A present-but-malformed value throws, naming the variable only
 * (`env.ts`'s never-log-values convention; the same shape as
 * `NARRATION_ACT_CONCURRENCY`).
 */
export const SPINE_STRUCTURAL_REASKS_ENV = "SPINE_STRUCTURAL_REASKS";
export const DEFAULT_SPINE_STRUCTURAL_REASKS = 1;

export function spineStructuralReasks(raw: string | undefined = process.env[SPINE_STRUCTURAL_REASKS_ENV]): number {
  if (raw === undefined) return DEFAULT_SPINE_STRUCTURAL_REASKS;
  const trimmed = raw.trim();
  const n = trimmed.length === 0 ? NaN : Number(trimmed);
  if (!Number.isInteger(n) || n < 0) {
    throw new Error(`Invalid value for environment variable ${SPINE_STRUCTURAL_REASKS_ENV}: expected a non-negative integer`);
  }
  return n;
}

/** One re-ask, as the report records it (`report.json`'s `spineReasks`). */
export interface SpineReask {
  /** 1-based: the first re-ask is 1. */
  attempt: number;
  /** The gate's messages the builder was asked to fix, verbatim. */
  violations: string[];
}

export interface BuildSpineOptions {
  /** Overrides `SPINE_STRUCTURAL_REASKS`; the pipeline passes it through from
   * `RunPipelineOptions.spineStructuralReasks`. */
  maxStructuralReasks?: number;
  /** Fired the moment a re-ask is decided on, BEFORE the builder is called
   * again — so the run log says what is being paid for while it is being paid
   * for, not after. */
  onReask?: (reask: SpineReask) => void;
}

export interface BuildSpineResult {
  spine: Spine;
  /** Empty when the first reply passed — the common case, and the one every
   * pre-F-86 caller sees. */
  reasks: SpineReask[];
}

/**
 * `buildSpine` with the re-ask record. The pipeline calls this one so the
 * report can carry `spineReasks`; every other caller keeps `buildSpine`'s
 * plain `Spine` return.
 */
export async function buildSpineWithReasks(
  intent: IntentUnderstanding,
  researchShape: ResearchShape,
  duration: DurationTier,
  builder: SpineBuilder,
  ctx: SpineBuildContext,
  options: BuildSpineOptions = {}
): Promise<BuildSpineResult> {
  const maxReasks = options.maxStructuralReasks ?? spineStructuralReasks();
  const seedableEpisodeIds = researchShape.subtopics.flatMap((s) => s.tapeWindows.map((w) => w.episodeId));
  const reasks: SpineReask[] = [];
  let revision: SpineRevisionRequest | undefined;

  for (let attempt = 0; ; attempt++) {
    /* Each iteration is one builder call — the first, then at most `maxReasks`
       re-asks. Every one of them meters itself through the budget guard the
       way any spine call does; this loop adds no second budget. */
    const rawSpine = await builder.buildSpine(intent, researchShape, duration, revision ? { ...ctx, revision } : ctx);

    // Schema-validate shape first (catches a builder that returns malformed
    // structure, e.g. a per-act voice field slipping in) before the
    // content-level checks in validateSpine.
    const spine = SpineSchema.parse(rawSpine);

    /* Gate 1 stays fail-fast. Counts, claim shape and the exploration floor
       have never refused a real spine (runs 1-7); the refusal F-86 answers
       was gate 2's. */
    const validation = validateSpine(spine);
    if (!validation.valid) {
      throw new InvalidSpineError(validation);
    }

    /* The confirmation loop F-13 found missing. `validateSpine` above checks
       counts, claim SHAPE and the exploration floor per beat; this checks the
       relationships a per-beat schema cannot see — the same claim written into
       two acts, a paragraph where a claim belongs, two sentences in one beat, an
       act with no start or end state. Placed here, between §4.3 and §4.4,
       because that is the last point at which a bad spine costs one Opus call
       rather than three deepen calls plus sourcing plus 31 narration pages.

       WS-L (F-63) adds one relationship to that list, between the spine and the
       RESEARCH MAP: when §4.2 quoted transcript windows, every act has to carry
       at least `SPINE_MIN_SEEDED_BEATS_PER_ACT` beats written from one of them,
       naming the episode. The episode ids come from here rather than from the
       spine because the check's whole point is that a seed must match something
       the map actually listed — a spine cannot pass by inventing one. When the
       map quoted nothing (a subject with no tape, a machine with no transcript
       bodies, CI) the set is empty and the rule does not apply.

       F-86: a refusal is re-asked, `maxReasks` times, before it fails the run.
       Only a spine that PASSED leaves this function, so the checkpoint the
       pipeline banks it in never holds a refused one. */
    const issues = checkSpineStructure(spine, { seedableEpisodeIds });
    if (issues.length === 0) return { spine, reasks };
    if (attempt >= maxReasks) throw new InvalidSpineStructureError(issues);

    const reask: SpineReask = { attempt: attempt + 1, violations: issues.map((i) => i.message) };
    reasks.push(reask);
    options.onReask?.(reask);
    revision = { previous: spine, violations: reask.violations, attempt: reask.attempt };
  }
}

export async function buildSpine(
  intent: IntentUnderstanding,
  researchShape: ResearchShape,
  duration: DurationTier,
  builder: SpineBuilder,
  ctx: SpineBuildContext,
  options: BuildSpineOptions = {}
): Promise<Spine> {
  return (await buildSpineWithReasks(intent, researchShape, duration, builder, ctx, options)).spine;
}
