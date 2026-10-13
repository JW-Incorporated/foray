import { z } from "zod";
import { enumParser, numberParser, readFlag, type FlagParser, type FlagSource } from "./generationFlags";
import { JUDGE_IDS, type JevResult, type JudgeId } from "./jevTypes";
import { SPECIFICS_MODES, type SpecificsMode } from "./specifics";

/**
 * GV-15 (docs/roadmap/generation-v2.md, W5-02): the gate configuration.
 *
 * IT STARTS EMPTY ON PURPOSE. Each gate card adds its own key to `GateConfig`
 * and its own row to `GATE_TABLE` (key, env var, parser, default) in the same
 * PR as the behaviour and the test behind it, so no gate flag ever exists
 * without a gate, and this card does not track the others. The planned keys
 * and their owning cards are listed in docs/curation/generation-architecture.md
 * §12.
 *
 * NO STAGE MODULE READS process.env FOR A GATE. `runForayPipeline` resolves
 * the config once per run (`RunPipelineOptions.gates` over
 * `readGateConfig()`), and each gate card threads its own key into the stage
 * options that need it (decision 34).
 *
 * Read at call time through `generationFlags.ts` (decision 5): a malformed
 * value throws naming the variable, never its value.
 *
 * GATES ARE DELIBERATELY NOT IN THE CHECKPOINT FINGERPRINT (W5-02): never feed
 * this config into `checkpointVariant`/`checkpointFingerprint`, or every banked
 * run is invalidated on a gate flip. A run resumed from stages banked under
 * another gate mode keeps that mode's output, so each gate card tests both its
 * default and its new mode (generation-architecture.md §12.2).
 */

/* Each gate card adds `key: Type` here. */
export interface GateConfig {
  /**
   * GV-34 (W5-10): FORAY_SPECIFICS_CHECK = off|report|enforce, default
   * `report`. Whether the numbers, years and names a narration sentence
   * states are checked in code against the sentence's sources
   * (`specifics.ts`). `report` computes `meta.veracity.specificsUnsupported`
   * and changes nothing in writeAct; `enforce` also refuses a seam that
   * states a specific no act source carries (a mechanical issue, so the
   * writer is re-asked); `off` computes nothing.
   */
  specifics: SpecificsMode;

  /*
   * GV-47 (OQ-05, W2-12 + W5-19): PER-JUDGE thresholds. Jev and the Qwen
   * judge answer through one interface (jevClient.ts), but their
   * probabilities are not comparable (a Qwen judge without logprobs reports
   * uncalibrated numbers), so every threshold has one key per judge and a
   * consumer reads it with `judgeThreshold(config, name, result.judge)`:
   * a Qwen answer is never read against a Jev threshold. GV-103's
   * calibration (calibrateJudges --judge jev|qwen) writes calibrated values
   * into these keys; until then the defaults are PROPOSED, and no gate reads
   * them yet (GV-51, GV-79 and later gate cards do), so they change no run.
   */
  /** FORAY_SUPPORT_MIN_P_JEV: a sentence (or beat) is supported when Jev's
   * probability is at least this. Default 0.5, PROPOSED. */
  "supportMinP.jev": number;
  /** FORAY_SUPPORT_MIN_P_QWEN: the same, for the Qwen judge. Default 0.7,
   * PROPOSED: stricter, because a 35B-A3B MoE's self-reported
   * probabilities run high. */
  "supportMinP.qwen": number;
  /** FORAY_CLIP_LEVEL_JEV: a clip is on its subject (and claim) when Jev's
   * 5-level score (0..4) is at least this. Default 3, PROPOSED (GV-79's
   * "subject >= 3 AND claim >= 3"). */
  "clipLevel.jev": number;
  /** FORAY_CLIP_LEVEL_QWEN: the same, for the Qwen judge. Default 3, PROPOSED. */
  "clipLevel.qwen": number;
}

/** GV-47: the thresholds that are kept per judge. */
export const JUDGE_THRESHOLD_NAMES = ["supportMinP", "clipLevel"] as const;
export type JudgeThresholdName = (typeof JUDGE_THRESHOLD_NAMES)[number];

/** One row of the declarative table. */
export interface GateTableEntry<T = unknown> {
  key: string;
  env: string;
  parse: FlagParser<T>;
  default: T;
}

/**
 * Builds a table, refusing a key or an env name used twice: two rows for one
 * variable would make the later row silently shadow the earlier one.
 */
export function defineGateTable(entries: readonly GateTableEntry[]): readonly GateTableEntry[] {
  const keys = new Set<string>();
  const envs = new Set<string>();
  for (const entry of entries) {
    if (keys.has(entry.key)) throw new Error(`gate table: duplicate key ${entry.key}`);
    if (envs.has(entry.env)) throw new Error(`gate table: duplicate env name ${entry.env}`);
    keys.add(entry.key);
    envs.add(entry.env);
  }
  return Object.freeze([...entries]);
}

const probabilityParser = numberParser(z.number().min(0).max(1), "a number from 0 to 1");
const clipLevelParser = numberParser(z.number().int().min(0).max(4), "an integer from 0 to 4");

/** The gate table. Each gate card appends its row. */
export const GATE_TABLE: readonly GateTableEntry[] = defineGateTable([
  { key: "specifics", env: "FORAY_SPECIFICS_CHECK", parse: enumParser(SPECIFICS_MODES), default: "report" } satisfies GateTableEntry<SpecificsMode>,
  { key: "supportMinP.jev", env: "FORAY_SUPPORT_MIN_P_JEV", parse: probabilityParser, default: 0.5 } satisfies GateTableEntry<number>,
  { key: "supportMinP.qwen", env: "FORAY_SUPPORT_MIN_P_QWEN", parse: probabilityParser, default: 0.7 } satisfies GateTableEntry<number>,
  { key: "clipLevel.jev", env: "FORAY_CLIP_LEVEL_JEV", parse: clipLevelParser, default: 3 } satisfies GateTableEntry<number>,
  { key: "clipLevel.qwen", env: "FORAY_CLIP_LEVEL_QWEN", parse: clipLevelParser, default: 3 } satisfies GateTableEntry<number>
]);

/**
 * The gate config in force for `source`. Pure: reads only `source`, and only
 * when called. An unset variable gives the row's default.
 */
export function readGateConfig(source: FlagSource = process.env, table: readonly GateTableEntry[] = GATE_TABLE): GateConfig {
  const config: Record<string, unknown> = {};
  for (const entry of table) config[entry.key] = readFlag(entry.env, entry.parse, entry.default, source);
  return config as unknown as GateConfig;
}

/**
 * `overrides` over `readGateConfig()`, once per run: a defined override beats
 * the env, and an undefined one leaves the env (or default) value in place.
 */
export function resolveGateConfig(
  overrides: Partial<GateConfig> = {},
  source: FlagSource = process.env,
  table: readonly GateTableEntry[] = GATE_TABLE,
): GateConfig {
  const merged: Record<string, unknown> = { ...readGateConfig(source, table) };
  for (const [key, value] of Object.entries(overrides)) if (value !== undefined) merged[key] = value;
  return merged as unknown as GateConfig;
}

/**
 * GV-47: the threshold `name` for the judge that answered. Reads ONLY that
 * judge's key; an unknown judge throws rather than borrowing another judge's
 * value. Pass `result.judge ?? "jev"` (an untagged result is Jev's: only
 * HttpJevClient leaves the tag off).
 */
export function judgeThreshold(config: GateConfig, name: JudgeThresholdName, judge: JudgeId): number {
  if (!(JUDGE_IDS as readonly string[]).includes(judge)) throw new Error(`judgeThreshold: unknown judge for ${name}`);
  if (!(JUDGE_THRESHOLD_NAMES as readonly string[]).includes(name)) throw new Error("judgeThreshold: unknown threshold");
  return config[`${name}.${judge}`];
}

/**
 * GV-47's fail-closed reading of one judged answer: true only when the judge
 * answered (`ok`) and question `questionId`'s value reaches the answering
 * judge's threshold `name`: a noul's probability, or a score's level. Every
 * `{ok:false}` (no key, the 'none' route, an outage both judges shared, a
 * malformed reply) and a missing answer are NOT passed. A choice has no
 * single value to compare, so its caller reads it; asking for one throws.
 */
export function judgedPass(result: JevResult, questionId: string, name: JudgeThresholdName, config: GateConfig): boolean {
  if (!result.ok) return false;
  const answer = result.answers.find((a) => a.id === questionId);
  if (answer === undefined) return false;
  const threshold = judgeThreshold(config, name, result.judge ?? "jev");
  switch (answer.type) {
    case "noul":
      return answer.noul >= threshold;
    case "score":
      return answer.score >= threshold;
    case "choice":
      throw new Error("judgedPass: a choice answer is read by its caller, not against one threshold");
  }
}
