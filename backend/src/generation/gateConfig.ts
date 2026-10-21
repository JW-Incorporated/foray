import { z } from "zod";
import { enumParser, numberParser, readFlag, type FlagParser, type FlagSource } from "./generationFlags";
import { JUDGE_IDS, type JevResult, type JudgeId } from "./jevTypes";
import { SPECIFICS_MODES, type SpecificsMode } from "./specifics";
import { VOICE_GATE_MODES, type VoiceGate, type VoiceGateMode } from "./voiceChecks";
import { READING_GRADE_BAND } from "../copy/spokenLine";

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
 *
 * GV-127 (#1413 item 36) narrows that rule to the gates that only REPORT. A
 * gate whose `enforce` mode re-asks the writer changes what `narrate:<i>`
 * banks, so FORAY_VOICE_GATE=enforce and FORAY_SPECIFICS_CHECK=enforce each
 * add one part (`voice=enforce`, `specifics=enforce`) to `checkpointRunVariant`
 * at both fingerprint sites; their `report` (default) and `off` modes add
 * nothing, so flipping between those, or any other gate, still invalidates no
 * banked run. A new gate whose enforce mode changes a banked stage joins the
 * variant the same way, only in that mode.
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

  /**
   * GV-79 (W5-03, MQ-05): FORAY_CLIP_JUDGE = off|shadow|enforce, default
   * `off`. Whether every placed clip is scored, off the timed path, for how
   * much it is about the listener's subject and how directly it makes its
   * beat's claim (`clipJudge.ts`, `scoreClips.ts`), and the result reported
   * as `meta.veracity.clipOnSubjectRate`. `shadow` records and reports;
   * `enforce` does the same, and is reserved for the publish gate's card
   * (GV-118, W5-06), which reads it. GV-107: `enforce` also pre-judges every
   * beat's candidate windows before sourcing (the checkpointed `clip-judge`
   * stage, `prejudgeClips.ts`); the book it banks is what GV-119's judged
   * walk will read, and until then it changes no sourcing. `off` runs nothing
   * and the report carries none of the fields.
   */
  clipJudge: ClipJudgeMode;

  /**
   * GV-107 (W5-04; R1-20, R2-03): FORAY_CLIP_JUDGE_TOP_K, default 2. Under
   * FORAY_CLIP_JUDGE=enforce each beat's candidate windows are put to the
   * judge as one choice (`prejudgeClips.ts`), and the K windows it ranks
   * highest are then asked the two clip Scores. Read only in `enforce` mode;
   * `off` and `shadow` build no candidate sets.
   */
  clipJudgeTopK: number;

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

  /**
   * GV-104 (W5-18; R2-14, QK-25): FORAY_VOICE_GATE = off|report|enforce,
   * default `report`. The spoken-line rules (N7-N9: reference leak, digits,
   * hedges, banned adjectives and openers, a rhetorical question with no
   * tape; N24: one numeric expression per sentence) on every seam the writer
   * returns (`voiceChecks.ts`). `enforce` makes a seam's hard errors
   * mechanical issues, so the seam is re-asked, from act
   * `voiceEnforceFromAct` on; `report` and `off` change nothing in the
   * writer. `report` and `enforce` add `meta.veracity.voice` (the scorecard,
   * from the final items); `off` leaves it out.
   */
  voice: VoiceGateMode;
  /** GV-104: FORAY_VOICE_ENFORCE_FROM_ACT, the first act (0-based) the
   * `enforce` mode re-asks seams in. Default 1, which keeps retries off act
   * 1's first-audio path (R2). */
  voiceEnforceFromAct: number;
  /** GV-104 (OQ-02): FORAY_READING_GRADE_BAND, `<lo>-<hi>`, the
   * Flesch-Kincaid band `meta.veracity.voice.gradeInBand` reads. Default
   * spokenLine.js's READING_GRADE_BAND (6-9). Scorecard only: no gate reads
   * the grade. */
  readingGradeBand: [number, number];

  /**
   * GV-108 (W5-12b; R2-13, QK-29, GP-26): FORAY_UNVERIFIED_SEAM_POLICY =
   * keep|cut, default `keep`. What a seam the act verifier never confirmed
   * leaves behind. `keep` is today's F-51 policy, byte for byte: the last
   * clean draft (or the confirmed text with a beat missing) kept with
   * `verified: false`, and the `no-page` hand-off (HANDOFF_SCRIPT) when no
   * attempt ever produced prose. `cut` keeps only the seam's introduction
   * sentences, checked in code (`writeAct.ts`'s `cutToIntroduction`), as a
   * verified `Intro` page on the clip it introduces; a seam with no such
   * sentence, or one that introduces no clip, gets no page, its narration
   * beats record `droppedReason: "unverified-cut"`, and the clips run
   * together. HANDOFF_SCRIPT is never produced in `cut` mode.
   *
   * `cut` changes what `narrate:<i>` banks, so by GV-127's rule above it
   * belongs in `checkpointRunVariant` (a `seamPolicy=cut` part, at both
   * fingerprint sites, only when on). That part lives in checkpoint.ts and
   * generateForays.ts, outside GV-108's files, and is a named follow-up:
   * until it lands, a `cut` run can resume narration banked under `keep`
   * (and the reverse), keeping that mode's pages.
   */
  unverifiedSeamPolicy: UnverifiedSeamPolicy;
}

/** GV-108: the policies for a seam the verifier never confirmed. */
export const UNVERIFIED_SEAM_POLICIES = ["keep", "cut"] as const;
export type UnverifiedSeamPolicy = (typeof UNVERIFIED_SEAM_POLICIES)[number];

/** GV-104: the writer-side voice gate of a resolved config. */
export function voiceGateOf(config: GateConfig): VoiceGate {
  return { mode: config.voice, enforceFromAct: config.voiceEnforceFromAct };
}

/** GV-79: the clip judge's modes (FORAY_CLIP_JUDGE). */
export const CLIP_JUDGE_MODES = ["off", "shadow", "enforce"] as const;
export type ClipJudgeMode = (typeof CLIP_JUDGE_MODES)[number];

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
const actIndexParser = numberParser(z.number().int().min(0).max(99), "an integer from 0 to 99");
const topKParser = numberParser(z.number().int().min(0).max(20), "an integer from 0 to 20");

/** GV-104: a grade band, `<lo>-<hi>` (or `<lo>,<hi>`), each 0..20, lo <= hi. */
export const gradeBandParser: FlagParser<[number, number]> = {
  parse: (raw) => {
    const m = /^(\d+(?:\.\d+)?)\s*[-,]\s*(\d+(?:\.\d+)?)$/.exec(raw);
    if (!m) return undefined;
    const lo = Number(m[1]);
    const hi = Number(m[2]);
    return lo <= hi && hi <= 20 ? [lo, hi] : undefined;
  },
  expected: "a grade band <lo>-<hi> with 0 <= lo <= hi <= 20"
};

/** The gate table. Each gate card appends its row. */
export const GATE_TABLE: readonly GateTableEntry[] = defineGateTable([
  { key: "specifics", env: "FORAY_SPECIFICS_CHECK", parse: enumParser(SPECIFICS_MODES), default: "report" } satisfies GateTableEntry<SpecificsMode>,
  { key: "clipJudge", env: "FORAY_CLIP_JUDGE", parse: enumParser(CLIP_JUDGE_MODES), default: "off" } satisfies GateTableEntry<ClipJudgeMode>,
  { key: "clipJudgeTopK", env: "FORAY_CLIP_JUDGE_TOP_K", parse: topKParser, default: 2 } satisfies GateTableEntry<number>,
  { key: "supportMinP.jev", env: "FORAY_SUPPORT_MIN_P_JEV", parse: probabilityParser, default: 0.5 } satisfies GateTableEntry<number>,
  { key: "supportMinP.qwen", env: "FORAY_SUPPORT_MIN_P_QWEN", parse: probabilityParser, default: 0.7 } satisfies GateTableEntry<number>,
  { key: "clipLevel.jev", env: "FORAY_CLIP_LEVEL_JEV", parse: clipLevelParser, default: 3 } satisfies GateTableEntry<number>,
  { key: "clipLevel.qwen", env: "FORAY_CLIP_LEVEL_QWEN", parse: clipLevelParser, default: 3 } satisfies GateTableEntry<number>,
  { key: "voice", env: "FORAY_VOICE_GATE", parse: enumParser(VOICE_GATE_MODES), default: "report" } satisfies GateTableEntry<VoiceGateMode>,
  { key: "voiceEnforceFromAct", env: "FORAY_VOICE_ENFORCE_FROM_ACT", parse: actIndexParser, default: 1 } satisfies GateTableEntry<number>,
  {
    key: "readingGradeBand",
    env: "FORAY_READING_GRADE_BAND",
    parse: gradeBandParser,
    default: [READING_GRADE_BAND[0], READING_GRADE_BAND[1]]
  } satisfies GateTableEntry<[number, number]>,
  { key: "unverifiedSeamPolicy", env: "FORAY_UNVERIFIED_SEAM_POLICY", parse: enumParser(UNVERIFIED_SEAM_POLICIES), default: "keep" } satisfies GateTableEntry<UnverifiedSeamPolicy>
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
 * GV-103: the gate-table row a calibrated value of threshold `name` for
 * `judge` goes into (key `<name>.<judge>`, its env variable and default), so
 * calibrateJudges names the exact variable to set and a follow-up PR copies
 * the value into the right row. Throws for an unknown judge or threshold,
 * like `judgeThreshold`.
 */
export function judgeThresholdEntry(name: JudgeThresholdName, judge: JudgeId, table: readonly GateTableEntry[] = GATE_TABLE): GateTableEntry<number> {
  if (!(JUDGE_IDS as readonly string[]).includes(judge)) throw new Error(`judgeThresholdEntry: unknown judge for ${name}`);
  if (!(JUDGE_THRESHOLD_NAMES as readonly string[]).includes(name)) throw new Error("judgeThresholdEntry: unknown threshold");
  const entry = table.find((e) => e.key === `${name}.${judge}`);
  if (!entry) throw new Error(`judgeThresholdEntry: no gate row for ${name}.${judge}`);
  return entry as GateTableEntry<number>;
}

/**
 * GV-103: the `VARIABLE=value` line that sets a calibrated threshold, or
 * null when the row's own parser refuses `value` (a clip level that is not
 * an integer 0..4, a probability outside 0..1): a recommendation the gate
 * could not read is never printed as a setting.
 */
export function judgeThresholdSetting(name: JudgeThresholdName, judge: JudgeId, value: number, table: readonly GateTableEntry[] = GATE_TABLE): string | null {
  const entry = judgeThresholdEntry(name, judge, table);
  const raw = String(value);
  return entry.parse.parse(raw) === undefined ? null : `${entry.env}=${raw}`;
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
