import { z } from "zod";
import { readBooleanFlag, readEnumFlag, readNumberFlag, type FlagSource } from "./generationFlags";
import { DEFAULT_SEED_FLOOR_REASKS } from "./postSeedSpine";

/**
 * GV-15 (docs/roadmap/generation-v2.md, W4-01): the per-run pipeline flags.
 *
 * EVERY FLAG DEFAULTS TO TODAY'S PIPELINE. With nothing set,
 * `readPipelineFlags()` returns `CLASSIC_PIPELINE_FLAGS` and the run is the
 * one main has always run. The fields exist so the critical-path cards
 * (fold-copy, fold-deepen, per-act pipeline, streaming writer, timed rounds,
 * runtime caps) each have one switch to read; this card adds the switches and
 * the checkpoint variant, and no stage reads a flag yet.
 *
 * PROVIDER CHOICES ARE NOT FLAGS (decision 4). Which service answers a stage
 * is chosen only through the stage routing table (`config/stageRouting.ts`,
 * FORAY_STAGE_<STAGE>=<impl>[:<lane>]). The `FORAY_FAST_PATH` umbrella sets
 * behaviour flags only.
 *
 * Read at call time through `generationFlags.ts` (decision 5): a malformed
 * value throws naming the variable, never its value.
 */

export type FoldDeepen = "off" | "short" | "all";
export type NarrationOrder = "parallel" | "sequential";
export type RoundPolicy = "default" | "timed";
export type SpineBestOf = 1 | 2;

export interface PipelineFlags {
  /** The `FORAY_FAST_PATH` umbrella (or `--fast-path`): sets the fast-path
   * defaults below; any per-field variable still overrides it. */
  fastPath: boolean;
  /** The spine call also writes the listener copy (GV-67). */
  foldSpineCopy: boolean;
  /** The spine call also carries the deepen fields: never, on the short
   * tier only, or on every tier (GV-86). */
  foldDeepen: FoldDeepen;
  /** Source, evidence and narrate one act at a time as soon as it is ready. */
  perActPipeline: boolean;
  /** Narrate acts all at once (today) or in act order. */
  narrationOrder: NarrationOrder;
  /** Stream the writer's reply. */
  writerStream: boolean;
  /** Round policy: today's re-asks, or the timed path's budgeted rounds. */
  roundPolicy: RoundPolicy;
  /** Cap a tier's runtime at its target. */
  tierRuntimeCap: boolean;
  /** The tier-fit gate. Not part of the fast-path umbrella. */
  tierFitGate: boolean;
  /** Best-of-N spine (GV-91). Stays 1 under the umbrella. */
  spineBestOf: SpineBestOf;
  /** Seed-floor re-asks the spine may cost on the timed path. */
  spineSeedFloorReasksOnTimedPath: number;
}

export const PIPELINE_FLAG_ENV = {
  fastPath: "FORAY_FAST_PATH",
  foldSpineCopy: "FORAY_SPINE_FOLD_COPY",
  foldDeepen: "FORAY_SPINE_FOLD_DEEPEN",
  perActPipeline: "FORAY_PER_ACT_PIPELINE",
  narrationOrder: "FORAY_NARRATION_ORDER",
  writerStream: "FORAY_WRITER_STREAM",
  roundPolicy: "FORAY_ROUND_POLICY",
  tierRuntimeCap: "FORAY_TIER_RUNTIME_CAP",
  tierFitGate: "FORAY_GATE_TIER_FIT",
  spineBestOf: "FORAY_SPINE_BEST_OF"
} as const;

/** Today's pipeline: what every flag is when nothing is set. */
export const CLASSIC_PIPELINE_FLAGS: Readonly<PipelineFlags> = Object.freeze({
  fastPath: false,
  foldSpineCopy: false,
  foldDeepen: "off",
  perActPipeline: false,
  narrationOrder: "parallel",
  writerStream: false,
  roundPolicy: "default",
  tierRuntimeCap: false,
  tierFitGate: false,
  spineBestOf: 1,
  spineSeedFloorReasksOnTimedPath: DEFAULT_SEED_FLOOR_REASKS
});

/** What `FORAY_FAST_PATH=1` changes. `tierFitGate` and `spineBestOf` are not
 * in it; the Jev clarity check is a routing choice
 * (`FORAY_STAGE_UNDERSTAND_CLARITY=jev`), not a flag. */
export const FAST_PATH_PIPELINE_FLAGS: Readonly<PipelineFlags> = Object.freeze({
  ...CLASSIC_PIPELINE_FLAGS,
  fastPath: true,
  foldSpineCopy: true,
  foldDeepen: "short",
  perActPipeline: true,
  narrationOrder: "sequential",
  writerStream: true,
  roundPolicy: "timed",
  tierRuntimeCap: true,
  spineSeedFloorReasksOnTimedPath: 0
});

const SPINE_BEST_OF_SCHEMA = z.number().int().min(1).max(2);

/**
 * The flags in force for `env`. The umbrella picks the base (classic or fast
 * path); each per-field variable then overrides its own field.
 */
export function readPipelineFlags(env: FlagSource = process.env): PipelineFlags {
  const fastPath = readBooleanFlag(PIPELINE_FLAG_ENV.fastPath, false, env);
  const base = fastPath ? FAST_PATH_PIPELINE_FLAGS : CLASSIC_PIPELINE_FLAGS;
  return {
    fastPath,
    foldSpineCopy: readBooleanFlag(PIPELINE_FLAG_ENV.foldSpineCopy, base.foldSpineCopy, env),
    foldDeepen: readEnumFlag<FoldDeepen>(PIPELINE_FLAG_ENV.foldDeepen, ["off", "short", "all"], base.foldDeepen, env),
    perActPipeline: readBooleanFlag(PIPELINE_FLAG_ENV.perActPipeline, base.perActPipeline, env),
    narrationOrder: readEnumFlag<NarrationOrder>(PIPELINE_FLAG_ENV.narrationOrder, ["parallel", "sequential"], base.narrationOrder, env),
    writerStream: readBooleanFlag(PIPELINE_FLAG_ENV.writerStream, base.writerStream, env),
    roundPolicy: readEnumFlag<RoundPolicy>(PIPELINE_FLAG_ENV.roundPolicy, ["default", "timed"], base.roundPolicy, env),
    tierRuntimeCap: readBooleanFlag(PIPELINE_FLAG_ENV.tierRuntimeCap, base.tierRuntimeCap, env),
    tierFitGate: readBooleanFlag(PIPELINE_FLAG_ENV.tierFitGate, base.tierFitGate, env),
    spineBestOf: readNumberFlag(PIPELINE_FLAG_ENV.spineBestOf, SPINE_BEST_OF_SCHEMA, base.spineBestOf, env) as SpineBestOf,
    spineSeedFloorReasksOnTimedPath: base.spineSeedFloorReasksOnTimedPath
  };
}

/**
 * The ONE merge both fingerprint call sites use (decision 20): `overrides`
 * over the env's flags. An override's `fastPath` decides the umbrella (so
 * `--fast-path` brings the fast-path defaults with it, and per-field
 * variables still win over them); every other override field wins outright.
 * Given a complete `PipelineFlags` it returns that object's values, so the
 * driver's merged flags pass through `runForayPipeline` unchanged.
 */
export function resolvePipelineFlags(overrides: Partial<PipelineFlags> = {}, env: FlagSource = process.env): PipelineFlags {
  const source = overrides.fastPath === undefined ? env : { ...env, [PIPELINE_FLAG_ENV.fastPath]: overrides.fastPath ? "1" : "0" };
  const merged: PipelineFlags = { ...readPipelineFlags(source) };
  for (const [key, value] of Object.entries(overrides) as [keyof PipelineFlags, PipelineFlags[keyof PipelineFlags]][]) {
    if (value !== undefined) (merged as unknown as Record<string, unknown>)[key] = value;
  }
  return merged;
}

/**
 * The checkpoint variant: a canonical string of the flags that change what a
 * banked stage HOLDS (fold-copy, fold-deepen, per-act), or `undefined` when
 * all of them are off, so a classic run keeps today's fingerprint exactly.
 *
 * Every other flag changes how a stage is reached, not what it banks, so it
 * stays out: a run with only `writerStream` on resumes a classic checkpoint.
 * The parts are in a fixed order and only the "on" ones appear, so each
 * combination maps to one string. GV-55 later joins the local routing into
 * the same variant at both call sites.
 *
 * GV-127 (#1413 item 40): `tierRuntimeCap` is the exception to "how, not
 * what". Since GV-89 it changes the banked `spine` and since GV-106 the
 * banked `source`, so it joins the variant too, but as its own part
 * (`tierCap=on`, `checkpoint.ts` `tierRuntimeCapVariant`), not here: the
 * fork stamp compares these flags exactly, and the cap is compared like a
 * spine route instead, so a stage-swap arm may still fork from `spine`.
 */
export function checkpointVariant(flags: Pick<PipelineFlags, "foldSpineCopy" | "foldDeepen" | "perActPipeline">): string | undefined {
  const parts: string[] = [];
  if (flags.foldSpineCopy) parts.push("foldCopy");
  if (flags.foldDeepen !== "off") parts.push(`foldDeepen=${flags.foldDeepen}`);
  if (flags.perActPipeline) parts.push("perAct");
  return parts.length ? parts.join(";") : undefined;
}
