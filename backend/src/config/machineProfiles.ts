import * as fs from "fs";
import { z } from "zod";
import { readString } from "./env";

/**
 * Lane profiles: the generation hardware written down as data (GV-03, from
 * W2-05; covers R1-08, R1-11).
 *
 * WHY THIS FILE EXISTS. Which local machine serves which stage, how many calls
 * it takes at once, and whether it may write prose were facts that lived in
 * people's heads and in the Baseline doc's HW rows. The open P40-vs-V100
 * question (OQ-01, R1-11) changes several of them at once. With the facts in
 * one validated table, settling that question is a config edit
 * (FORAY_MACHINE_PROFILES_FILE or a one-line follow-up PR), not a code change.
 *
 * NOTHING READS THIS YET. stageRouting.ts uses `allowsProse` and `modelAlias`;
 * the provider layer (GV-13, GV-37) and the lane scheduler (GV-93) read the
 * rest once they land. Defining the table does not change any run.
 *
 * Two lanes:
 * - `spark`: the DGX Spark (Qwen behind LiteLLM). Prose stays here.
 * - `second`: the second box (Hermes records 2x Tesla P40; the founder said
 *   V100s; OQ-01 open). Planning-side JSON work only, under a prompt ceiling.
 */

export type LaneId = "spark" | "second";

export const LANE_IDS: readonly LaneId[] = ["spark", "second"] as const;

/** The variable that points at a JSON file overriding the defaults below. */
export const MACHINE_PROFILES_FILE_ENV = "FORAY_MACHINE_PROFILES_FILE";

const laneIdSchema = z.enum(["spark", "second"]);

const decodeSchema = z
  .object({
    /** tokens/s decoding constrained JSON */
    json: z.number().positive(),
    /** tokens/s decoding free prose */
    prose: z.number().positive()
  })
  .strict();

const serverPrioritySchema = z
  .object({
    /** true only once the server runs with priority scheduling enabled */
    enabled: z.boolean(),
    /** `priority` sent on critical-path calls (sign convention unverified) */
    critical: z.number().int(),
    /** `priority` sent on background calls */
    background: z.number().int()
  })
  .strict();

const laneProfileSchema = z
  .object({
    id: laneIdSchema,
    /** the LiteLLM model alias requests on this lane name */
    modelAlias: z.string().trim().min(1),
    /** Foray policy: calls in flight on this lane at once */
    maxConcurrent: z.number().int().min(1),
    /** slots of maxConcurrent that background calls may not take */
    reservedCritical: z.number().int().min(0),
    prefillTokPerSec: z.number().positive(),
    decodeTokPerSec: decodeSchema,
    /** prompts above this are not sent to the lane; null = no ceiling */
    promptCeilingTokens: z.number().int().positive().nullable(),
    /** may the act writer (spoken prose) run here */
    allowsProse: z.boolean(),
    /** how the lane constrains JSON output */
    structuredOutput: z.enum(["json_schema", "json_object", "none"]),
    /** does the lane return token logprobs */
    logprobs: z.boolean(),
    serverPriority: serverPrioritySchema,
    usdPerMtokIn: z.number().min(0),
    usdPerMtokOut: z.number().min(0)
  })
  .strict()
  .refine((p) => p.reservedCritical <= p.maxConcurrent, {
    message: "reservedCritical must not exceed maxConcurrent",
    path: ["reservedCritical"]
  });

export type LaneProfile = z.infer<typeof laneProfileSchema>;

export type LaneProfiles = Readonly<Record<LaneId, LaneProfile>>;

/**
 * The defaults, each value with its source.
 *
 * Stale facts to know about (GV-03 risk): HW-01/HW-03 say the Spark has 4
 * slots, but production lane A2 has served 9 concurrent requests since
 * 2026-10-03 (roadmap decision 26), so `maxConcurrent: 2` is a Foray policy
 * (one critical stream plus limited background work, R1-08), not a hardware
 * limit. The second box is unverified (P40 per Hermes, with XID-latch
 * incidents on 2026-10-02, versus the founder's V100); the live step of GV-03
 * re-measures it.
 */
export const DEFAULT_LANE_PROFILES: LaneProfiles = Object.freeze({
  spark: Object.freeze({
    id: "spark",
    // LiteLLM alias of the Spark's heavy model (Qwen3.8-27B on SGLang), roadmap GV-03.
    modelAlias: "local-heavy",
    // Foray policy, not a hardware limit (decision 26; R1-08).
    maxConcurrent: 2,
    // One slot always free for the critical path (R1-08, R1-12).
    reservedCritical: 1,
    // HW-02: Spark prefill rate.
    prefillTokPerSec: 1900,
    // Hermes lane A2 tune report, 2026-10-03.
    decodeTokPerSec: Object.freeze({ json: 83, prose: 21.8 }),
    promptCeilingTokens: null,
    // The plan's ruling: prose stays on the Spark.
    allowsProse: true,
    structuredOutput: "json_schema",
    // SGLang's OpenAI-compatible server returns logprobs.
    logprobs: true,
    // Lane A2 runs without --enable-priority-scheduling (decision 26).
    serverPriority: Object.freeze({ enabled: false, critical: 0, background: 0 }),
    // Owned hardware: no per-token price.
    usdPerMtokIn: 0,
    usdPerMtokOut: 0
  }),
  second: Object.freeze({
    id: "second",
    // LiteLLM alias of the second box's worker model (Qwen3.6-35B-A3B per Hermes), roadmap GV-03.
    modelAlias: "local-worker",
    // One per P40 (llama-server --parallel 1 on each card), roadmap GV-03.
    maxConcurrent: 2,
    // Not stated by the plan; the lane scheduler (GV-93) tunes it.
    reservedCritical: 0,
    // HW-06: the P40 reads at 895 tok/s.
    prefillTokPerSec: 895,
    // HW-06: the P40 writes at 51 tok/s; one figure, used for both shapes.
    decodeTokPerSec: Object.freeze({ json: 51, prose: 51 }),
    // Planning-side JSON calls only; a long prompt at 895 tok/s is too slow (HW-06).
    promptCeilingTokens: 2000,
    // The plan's ruling: no prose on the second box (FORAY_ALLOW_PROSE_ON_SECOND=1 overrides).
    allowsProse: false,
    structuredOutput: "json_schema",
    // Unverified through LiteLLM on llama-server; set true after the live step confirms it.
    logprobs: false,
    serverPriority: Object.freeze({ enabled: false, critical: 0, background: 0 }),
    usdPerMtokIn: 0,
    usdPerMtokOut: 0
  })
}) as LaneProfiles;

/** Thrown for a malformed or unreadable profiles file. Names the variable,
 * never the file's content (env.ts's never-log-values convention). */
export class MachineProfilesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MachineProfilesError";
  }
}

/* A file entry overrides only the fields it names; nested objects merge one
   level deep. `.strict()` everywhere, so a misspelt field is an error rather
   than a silently ignored override. */
const laneOverrideSchema = z
  .object({
    id: laneIdSchema.optional(),
    modelAlias: z.string().optional(),
    maxConcurrent: z.number().optional(),
    reservedCritical: z.number().optional(),
    prefillTokPerSec: z.number().optional(),
    decodeTokPerSec: decodeSchema.partial().strict().optional(),
    promptCeilingTokens: z.number().nullable().optional(),
    allowsProse: z.boolean().optional(),
    structuredOutput: z.string().optional(),
    logprobs: z.boolean().optional(),
    serverPriority: serverPrioritySchema.partial().strict().optional(),
    usdPerMtokIn: z.number().optional(),
    usdPerMtokOut: z.number().optional()
  })
  .strict();

const profilesFileSchema = z
  .object({
    spark: laneOverrideSchema.optional(),
    second: laneOverrideSchema.optional()
  })
  .strict();

function fail(detail: string): never {
  throw new MachineProfilesError(`Invalid ${MACHINE_PROFILES_FILE_ENV}: ${detail}`);
}

/** Field paths only: zod messages can quote the offending value. */
function issuePaths(error: z.ZodError): string {
  const paths = error.issues.map((i) => (i.path.length > 0 ? i.path.join(".") : "(root)"));
  return [...new Set(paths)].join(", ");
}

/**
 * Merges a parsed override document over the defaults and validates every
 * lane. Pure; exported so a test can drive it without a file.
 */
export function mergeLaneProfiles(overrides: unknown, base: LaneProfiles = DEFAULT_LANE_PROFILES): LaneProfiles {
  const parsed = profilesFileSchema.safeParse(overrides);
  if (!parsed.success) fail(`unexpected shape at ${issuePaths(parsed.error)}`);
  const out = {} as Record<LaneId, LaneProfile>;
  for (const lane of LANE_IDS) {
    const d = base[lane];
    const o = parsed.data[lane] ?? {};
    if (o.id !== undefined && o.id !== lane) fail(`${lane}.id must be "${lane}"`);
    const merged = {
      ...d,
      ...o,
      id: lane,
      decodeTokPerSec: { ...d.decodeTokPerSec, ...(o.decodeTokPerSec ?? {}) },
      serverPriority: { ...d.serverPriority, ...(o.serverPriority ?? {}) }
    };
    const checked = laneProfileSchema.safeParse(merged);
    if (!checked.success) fail(`invalid ${lane} lane at ${issuePaths(checked.error)}`);
    out[lane] = checked.data;
  }
  return Object.freeze(out);
}

export type ReadTextFile = (path: string) => string;

const defaultReadFile: ReadTextFile = (p) =>
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied config path (FORAY_MACHINE_PROFILES_FILE), read-only.
  fs.readFileSync(p, "utf8");

/**
 * The lane profiles for a run: the defaults, or the defaults with
 * FORAY_MACHINE_PROFILES_FILE merged over them. A set-but-unreadable,
 * non-JSON or invalid file throws MachineProfilesError naming the variable.
 */
export function loadLaneProfiles(source: NodeJS.ProcessEnv = process.env, readFile: ReadTextFile = defaultReadFile): LaneProfiles {
  const file = readString(MACHINE_PROFILES_FILE_ENV, source);
  if (file === undefined) return DEFAULT_LANE_PROFILES;
  let text: string;
  try {
    text = readFile(file);
  } catch {
    fail("the file could not be read");
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    fail("the file is not valid JSON");
  }
  return mergeLaneProfiles(json);
}
