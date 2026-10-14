import { z } from "zod";
import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape } from "../types/research";
import { SpineSchema, validateSpine, type DurationTier, type Spine, type SpineValidationResult } from "../types/spine";
import { checkSpineStructure, foldedCopyIssues, InvalidSpineStructureError } from "./spineStructure";
import type { SpineBuildContext, SpineBuilder, SpineRevisionRequest } from "./SpineBuilder";
import { withCallContext } from "./runLog";
import { postSeedSpine } from "./postSeedSpine";
import { runtimeViolations, spineCannotFit, spineRuntimeLowerBoundSec } from "./tierRuntime";

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
  /** GV-89: `"runtime"` on the post-spine runtime re-ask (`reaskForRuntime`),
   * whose violations name the overrun. Absent on a structural re-ask, so
   * F-86's rows in `report.json` are unchanged. */
  kind?: "runtime";
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
/**
 * GV-67: the schema a FOLDED reply is parsed with before the gates. The same
 * as SpineSchema but for a blank subject or angle, which on the folded path
 * is the reply's own omission (`spineFromReply` never fills it from the
 * keyword intent): it must reach the structural gate as a re-askable
 * violation (`foldedCopyIssues`), not end the run as a schema error. Only a
 * spine that passed that gate leaves `buildSpineWithReasks`, so what the
 * pipeline banks still parses under SpineSchema.
 */
const FoldedReplySpineSchema = SpineSchema.extend({ subject: z.string(), angle: z.string() });

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
  /* GV-67: a folded call (the spine writes the listener copy) also gates the
     copy fields the reply must carry. */
  const folded = ctx.listenerPrompt !== undefined;

  for (let attempt = 0; ; attempt++) {
    /* Each iteration is one builder call — the first, then at most `maxReasks`
       re-asks. Every one of them meters itself through the budget guard the
       way any spine call does; this loop adds no second budget. */
    const buildCtx = revision ? { ...ctx, revision } : ctx;
    /* GV-07: a structural re-ask's model calls are recorded as such (a no-op
       wrapper outside a RunLog). */
    const rawSpine = await withCallContext({ reask: attempt > 0 ? "structural" : undefined, attempt }, () =>
      builder.buildSpine(intent, researchShape, duration, buildCtx)
    );

    // Schema-validate shape first (catches a builder that returns malformed
    // structure, e.g. a per-act voice field slipping in) before the
    // content-level checks in validateSpine.
    const spine = (folded ? FoldedReplySpineSchema : SpineSchema).parse(rawSpine);

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
    const issues = [...(folded ? foldedCopyIssues(spine) : []), ...checkSpineStructure(spine, { seedableEpisodeIds })];
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

/* ────────────────────────────────────────────────────────────────────────────
   GV-89 (W4-14): one runtime re-ask for a plan that cannot fit its tier.
   ──────────────────────────────────────────────────────────────────────────── */

export interface RuntimeReaskOptions {
  /** Fired the moment the re-ask is decided on, BEFORE the builder is called,
   * so the run log says what is being paid for while it is being paid for. */
  onReask?: (reask: SpineReask) => void;
}

export interface RuntimeReaskResult {
  /** The spine the run keeps: the post-seeded reply when it was accepted,
   * otherwise the spine passed in, unchanged. */
  spine: Spine;
  /** The re-ask, for `spineReasks`; null when the plan already fit (no call). */
  reask: SpineReask | null;
  /** Whether the reply replaced the spine passed in. */
  accepted: boolean;
}

/** The re-ask turn shows the model its plan with the seeds that make up the
 * overrun, post-seeding's included (they count toward the bound), but without
 * `seedSource`: that mark is the pipeline's bookkeeping, not a field the
 * prompt asked the model to write. */
function withoutSeedSource(spine: Spine): Spine {
  return {
    ...spine,
    acts: spine.acts.map((act) => ({
      ...act,
      slots: act.slots.map((slot) => ({
        ...slot,
        beats: slot.beats.map((beat) => {
          if (beat.seedSource === undefined) return beat;
          const { seedSource: _dropped, ...rest } = beat;
          return rest;
        })
      }))
    }))
  };
}

/**
 * GV-89: THE POST-SPINE RUNTIME CHECK. `spine` is the post-seeded spine (seeds
 * are final there, so seeds post-seeding attached count toward the bound).
 * When its minimum runtime (`tierRuntime.ts`) is over the tier's hard ceiling,
 * the builder is re-asked ONCE with revision.kind 'runtime' and the overrun
 * named; a plan that fits costs no call.
 *
 * The reply must pass the same gates the first reply passed (the schema,
 * `validateSpine`, `checkSpineStructure` against the map's episodes, and on a
 * folded call the copy fields). It is then post-seeded deterministically,
 * with NO further seed-floor re-ask. A reply that fails a gate, or whose
 * minimum runtime is longer than the spine it was asked to shorten, is
 * dropped and the spine passed in is kept: the call is spent either way,
 * but the run is never made worse by it. If the kept plan still overruns,
 * the run continues and GV-106's sourcing ceiling (W4-15) enforces the limit.
 *
 * The caller decides whether the check applies (FORAY_TIER_RUNTIME_CAP).
 */
export async function reaskForRuntime(
  spine: Spine,
  intent: IntentUnderstanding,
  researchShape: ResearchShape,
  duration: DurationTier,
  builder: SpineBuilder,
  ctx: SpineBuildContext,
  options: RuntimeReaskOptions = {}
): Promise<RuntimeReaskResult> {
  if (!spineCannotFit(spine, duration)) return { spine, reask: null, accepted: false };

  const violations = runtimeViolations(spine, duration);
  const reask: SpineReask = { attempt: 1, violations, kind: "runtime" };
  options.onReask?.(reask);
  const revision: SpineRevisionRequest = { previous: withoutSeedSource(spine), violations, attempt: 1, kind: "runtime" };
  /* GV-07: the runtime re-ask's model calls are recorded as such (a no-op
     wrapper outside a RunLog). */
  const raw = await withCallContext({ reask: "runtime" }, () => builder.buildSpine(intent, researchShape, duration, { ...ctx, revision }));

  const folded = ctx.listenerPrompt !== undefined;
  const parsed = (folded ? FoldedReplySpineSchema : SpineSchema).safeParse(raw);
  if (!parsed.success) return { spine, reask, accepted: false };
  const reply = parsed.data;
  const seedableEpisodeIds = researchShape.subtopics.flatMap((s) => s.tapeWindows.map((w) => w.episodeId));
  const issues = [...(folded ? foldedCopyIssues(reply) : []), ...checkSpineStructure(reply, { seedableEpisodeIds })];
  if (!validateSpine(reply).valid || issues.length > 0) return { spine, reask, accepted: false };

  const reseeded = postSeedSpine(reply, researchShape).spine;
  if (spineRuntimeLowerBoundSec(reseeded) > spineRuntimeLowerBoundSec(spine)) return { spine, reask, accepted: false };
  return { spine: reseeded, reask, accepted: true };
}
