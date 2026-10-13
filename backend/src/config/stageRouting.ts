import * as fs from "fs";
import { readString } from "./env";
import { resolveModelId, type ModelTier } from "./models";
import { LANE_IDS, loadLaneProfiles, type LaneId, type LaneProfile, type LaneProfiles } from "./machineProfiles";

/**
 * The stage routing table and the stage implementation registry (GV-03, from
 * W2-05 and the registry half of W7-02; covers R2-21, R1-08, R1-11, GP-27).
 *
 * WHY THIS FILE EXISTS. Today the model that serves a stage is chosen by tier
 * alone (config/models.ts), and Stub-vs-Anthropic by `env.anthropicDryRun`
 * alone, so one variable (FORAY_MODEL_SONNET) swaps four stages at once and
 * nothing can put one stage on a local machine. Roadmap decision 4 makes ONE
 * mechanism the stage switch:
 *
 *     FORAY_STAGE_<STAGE>=<impl>[:<lane>]       e.g. FORAY_STAGE_SPINE=local:second
 *
 * read here, over a generation mode:
 *
 * - FORAY_GENERATION_MODE = stub | local | anthropic-legacy, when set;
 * - otherwise `local` when FORAY_LLM_BASE_URL is set, else `stub`.
 *
 * ZERO ANTHROPIC CALLS (GV-68, the founder's rule for the generation
 * pipeline; docs/roadmap/generation-v2.md "Constraints"). ANTHROPIC_API_KEY no
 * longer selects a mode: with only a key set, every stage is the Stub, and the
 * table says the key was ignored (anthropicKeyIgnored, the driver's MODE
 * line). The legacy Anthropic builders need TWO explicit opt-ins,
 * FORAY_GENERATION_MODE=anthropic-legacy AND FORAY_ALLOW_ANTHROPIC_LEGACY=1;
 * an 'anthropic' route (the legacy mode's default, or any FORAY_STAGE_*=anthropic)
 * without both throws RoutingConfigError naming the rule. env.anthropicDryRun
 * is NOT changed: enrich/ and buildSession.ts rely on it.
 *
 * With neither FORAY_GENERATION_MODE, FORAY_LLM_BASE_URL nor any
 * FORAY_STAGE_* set, every stage is the Stub (the judge fail-closed 'none').
 *
 * SHELL-ENV CAVEAT: FORAY_LLM_BASE_URL ALONE switches every stage to local
 * mode. A dev shell that still exports it from an earlier session runs every
 * stage on the lanes; pin FORAY_GENERATION_MODE=stub (or unset the variable)
 * for a stub run (docs/curation/generation-providers.md).
 *
 * PURE AND DARK. resolveRouting reads an injected source (process.env by
 * default) and touches no global state except the registry below, which is
 * empty until the stage factories register their built-ins (GV-37). Nothing in
 * the pipeline reads this module yet, so it changes no run. config/env.ts and
 * env.anthropicDryRun are untouched: enrich/ and buildSession.ts depend on
 * that getter.
 *
 * NEVER LOGS VALUES. Every error names the variable only (buildSpine.ts's
 * spineStructuralReasks pattern), and routingSummary() carries no key and no
 * URL credentials.
 */

/** Every routable stage. Exported as the one list other tools import
 * (GV-75 sets each one explicitly), never counted by hand. 'spine-alt' has no
 * default: it is the best-of-2 spine's second sampler (GV-91). */
export const GENERATION_STAGES = [
  "understand.clarity",
  "understand.intent",
  "understand.title",
  "research",
  "spine",
  "spine-alt",
  "deepen",
  "writer",
  "verifier",
  "continuity",
  "judge"
] as const;

export type StageId = (typeof GENERATION_STAGES)[number];

/** Implementation ids a route may name. stub, anthropic (legacy) and local
 * are the factories' built-ins (GV-37); none and dossier are research routes
 * (GV-61, GV-69); jev serves clarity, the verifier and the judge (GV-49,
 * GV-51, GV-47). On the judge stage (GV-47), local:<lane> is the Qwen judge
 * (generation/qwenJudgeClient.ts), jev:<lane> is Jev with the Qwen judge on
 * <lane> as its fallback, and none is fail-closed (createJevClient returns
 * NullJevClient). */
export const STAGE_PROVIDERS = ["stub", "anthropic", "local", "none", "jev", "dossier"] as const;

export type StageProvider = (typeof STAGE_PROVIDERS)[number];

export const GENERATION_MODES = ["stub", "local", "anthropic-legacy"] as const;

export type GenerationMode = (typeof GENERATION_MODES)[number];

export const GENERATION_MODE_ENV = "FORAY_GENERATION_MODE";
export const LLM_BASE_URL_ENV = "FORAY_LLM_BASE_URL";
export const LLM_API_KEY_ENV = "FORAY_LLM_API_KEY";
export const LLM_API_KEY_FILE_ENV = "FORAY_LLM_API_KEY_FILE";
export const ALLOW_PROSE_ON_SECOND_ENV = "FORAY_ALLOW_PROSE_ON_SECOND";
/** GV-68: the second of the two opt-ins the legacy Anthropic builders need
 * (the first is FORAY_GENERATION_MODE=anthropic-legacy). */
export const ALLOW_ANTHROPIC_LEGACY_ENV = "FORAY_ALLOW_ANTHROPIC_LEGACY";
export const ANTHROPIC_API_KEY_ENV = "ANTHROPIC_API_KEY";
/** GV-68: the rule an 'anthropic' route without both opt-ins breaks, quoted in
 * every refusal so the error names it. */
export const ZERO_ANTHROPIC_RULE =
  "the generation pipeline makes zero Anthropic calls (founder rule, docs/roadmap/generation-v2.md Constraints)";
/** GV-47: where a Jev key can come from (config/env.ts readJevApiKey). Only
 * their presence is read here, never a key. */
export const JEV_KEY_ENVS = ["JEV_API_KEY", "JEV_KEY_FILE"] as const;

export interface StageRoute {
  provider: StageProvider;
  /** local only (and a jev route's fallback): the machine that serves it */
  lane?: LaneId;
  /** the model id or alias sent, or the provider id for stub/none/jev/dossier */
  model: string;
  thinking?: boolean;
  temperature?: number;
  /** anthropic only: the models.ts tier the legacy builder uses */
  tier?: ModelTier;
  /** jev only: the local lane that answers when Jev cannot (OQ-05, GV-47) */
  fallback?: { provider: "local"; lane: LaneId; model: string };
}

export interface RoutingTable {
  mode: GenerationMode;
  /** which variable decided the mode ('default' = none of them: stub).
   * GV-68: ANTHROPIC_API_KEY never decides it. */
  modeSource: "FORAY_GENERATION_MODE" | "FORAY_LLM_BASE_URL" | "default";
  /** GV-68: ANTHROPIC_API_KEY is set but no stage is routed 'anthropic', so
   * the key selects nothing (the driver's MODE line says so). */
  anthropicKeyIgnored: boolean;
  /** one route per stage; 'spine-alt' is absent unless FORAY_STAGE_SPINE_ALT is set */
  routes: Readonly<Partial<Record<StageId, StageRoute>>>;
  /** stages a FORAY_STAGE_* variable set, in GENERATION_STAGES order */
  overridden: readonly StageId[];
  /** FORAY_LLM_BASE_URL as given (may carry credentials: never log it; use routingSummary) */
  llmBaseUrl: string | null;
  /** FORAY_LLM_API_KEY or FORAY_LLM_API_KEY_FILE is set (the key itself is never read here) */
  llmKeyConfigured: boolean;
  profiles: LaneProfiles;
}

/** A routing misconfiguration. `variable` is the env variable to fix; the
 * message never contains its value. */
export class RoutingConfigError extends Error {
  readonly variable: string;
  constructor(variable: string, message: string) {
    super(message);
    this.name = "RoutingConfigError";
    this.variable = variable;
  }
}

/** FORAY_STAGE_<STAGE>: dots and dashes become underscores
 * (understand.clarity -> FORAY_STAGE_UNDERSTAND_CLARITY, spine-alt -> FORAY_STAGE_SPINE_ALT). */
export function stageEnvVar(stage: StageId): string {
  return `FORAY_STAGE_${stage.toUpperCase().replace(/[.-]/g, "_")}`;
}

/** Today's tier per stage (the `modelFor(...)` line of each Anthropic*
 * builder). The understander's title restyle (sentenceCaseTitle) and the
 * clarity call share its haiku row; the researcher is haiku; the spine is the
 * one opus call; spine-alt mirrors the spine. */
const LEGACY_TIERS: Readonly<Partial<Record<StageId, ModelTier>>> = Object.freeze({
  "understand.clarity": "haiku",
  "understand.intent": "haiku",
  "understand.title": "haiku",
  research: "haiku",
  spine: "opus",
  "spine-alt": "opus",
  deepen: "sonnet",
  writer: "sonnet",
  verifier: "sonnet",
  continuity: "sonnet"
});

/** The implementation ids each stage accepts. Anything else is an unknown value. */
const ALLOWED_PROVIDERS: Readonly<Record<StageId, readonly StageProvider[]>> = Object.freeze({
  "understand.clarity": ["stub", "anthropic", "local", "jev"],
  "understand.intent": ["stub", "anthropic", "local"],
  "understand.title": ["stub", "anthropic", "local"],
  research: ["stub", "anthropic", "none", "dossier"],
  spine: ["stub", "anthropic", "local"],
  "spine-alt": ["stub", "anthropic", "local"],
  deepen: ["stub", "anthropic", "local"],
  writer: ["stub", "anthropic", "local"],
  verifier: ["stub", "anthropic", "local", "jev"],
  continuity: ["stub", "anthropic", "local"],
  judge: ["jev", "local", "none"]
});

/** The lane `local` means when a route names no lane, and the local-mode
 * default (the plan's ruling: prose and the critical planning calls on the
 * Spark, deepen on the second box; the judge falls back to the second box). */
const LOCAL_DEFAULT_LANE: Readonly<Record<StageId, LaneId>> = Object.freeze({
  "understand.clarity": "spark",
  "understand.intent": "spark",
  "understand.title": "spark",
  research: "spark",
  spine: "spark",
  "spine-alt": "spark",
  deepen: "second",
  writer: "spark",
  verifier: "spark",
  continuity: "spark",
  judge: "second"
});

/** A parsed route request, before it is turned into a StageRoute. */
interface RouteSpec {
  provider: StageProvider;
  lane?: LaneId;
}

/** Local-mode defaults. research 'none' (OQ-04: no web research on the timed
 * path); judge jev with a local:second fallback (OQ-05, GV-47: the Qwen judge
 * on the second box answers when Jev cannot). */
const LOCAL_MODE_DEFAULTS: Readonly<Partial<Record<StageId, RouteSpec>>> = Object.freeze({
  "understand.clarity": { provider: "local", lane: "spark" },
  "understand.intent": { provider: "local", lane: "spark" },
  "understand.title": { provider: "local", lane: "spark" },
  research: { provider: "none" },
  spine: { provider: "local", lane: "spark" },
  deepen: { provider: "local", lane: "second" },
  writer: { provider: "local", lane: "spark" },
  verifier: { provider: "local", lane: "spark" },
  continuity: { provider: "local", lane: "spark" },
  judge: { provider: "jev", lane: "second" }
});

/** True when JEV_API_KEY or JEV_KEY_FILE is set in `source` (presence only). */
export function jevKeyConfigured(source: NodeJS.ProcessEnv): boolean {
  return JEV_KEY_ENVS.some((name) => readString(name, source) !== undefined);
}

function defaultSpec(stage: StageId, mode: GenerationMode, source: NodeJS.ProcessEnv): RouteSpec | undefined {
  if (stage === "spine-alt") return undefined;
  /* GV-47: outside local mode the judge is Jev when a Jev key exists, with no
     fallback, else 'none' (fail-closed: an unjudged gate never passes).
     Nothing on the default pipeline asks the judge yet, so this changes no
     run. */
  if (stage === "judge" && mode !== "local") return jevKeyConfigured(source) ? { provider: "jev" } : { provider: "none" };
  if (mode === "stub") return { provider: "stub" };
  if (mode === "anthropic-legacy") return { provider: "anthropic" };
  return LOCAL_MODE_DEFAULTS[stage];
}

const WORD_RE = /^[a-z]+$/;

function unknownValue(variable: string, stage: StageId): never {
  throw new RoutingConfigError(
    variable,
    `Invalid value for environment variable ${variable}: expected one of ${ALLOWED_PROVIDERS[stage].join(", ")}` +
      `, optionally followed by :<lane> (${LANE_IDS.join(", ")})`
  );
}

function parseSpec(stage: StageId, raw: string): RouteSpec {
  const variable = stageEnvVar(stage);
  const parts = raw.split(":");
  if (parts.length > 2 || !parts.every((p) => WORD_RE.test(p))) unknownValue(variable, stage);
  const provider = parts[0] as StageProvider;
  if (!ALLOWED_PROVIDERS[stage].includes(provider)) unknownValue(variable, stage);
  const lane = parts[1];
  if (lane === undefined) return { provider };
  if (provider !== "local" && provider !== "jev") unknownValue(variable, stage);
  if (!(LANE_IDS as readonly string[]).includes(lane)) unknownValue(variable, stage);
  return { provider, lane: lane as LaneId };
}

function readMode(source: NodeJS.ProcessEnv): { mode: GenerationMode; modeSource: RoutingTable["modeSource"] } {
  const explicit = readString(GENERATION_MODE_ENV, source);
  if (explicit !== undefined) {
    if (!(GENERATION_MODES as readonly string[]).includes(explicit)) {
      throw new RoutingConfigError(
        GENERATION_MODE_ENV,
        `Invalid value for environment variable ${GENERATION_MODE_ENV}: expected one of ${GENERATION_MODES.join(", ")}`
      );
    }
    return { mode: explicit as GenerationMode, modeSource: "FORAY_GENERATION_MODE" };
  }
  /* GV-68: ANTHROPIC_API_KEY no longer selects anthropic-legacy. */
  if (readString(LLM_BASE_URL_ENV, source) !== undefined) return { mode: "local", modeSource: "FORAY_LLM_BASE_URL" };
  return { mode: "stub", modeSource: "default" };
}

/** GV-68: FORAY_ALLOW_ANTHROPIC_LEGACY is exactly "1" (unset or "0" is off;
 * any other value is refused, naming the variable). */
function allowAnthropicLegacy(source: NodeJS.ProcessEnv): boolean {
  const raw = readString(ALLOW_ANTHROPIC_LEGACY_ENV, source);
  if (raw === undefined || raw === "0") return false;
  if (raw === "1") return true;
  throw new RoutingConfigError(ALLOW_ANTHROPIC_LEGACY_ENV, `Invalid value for environment variable ${ALLOW_ANTHROPIC_LEGACY_ENV}: expected 1 or 0`);
}

/** GV-68: an 'anthropic' route needs both opt-ins. Throws naming the rule and
 * the variable still missing (the mode first, then the allow flag). */
function assertAnthropicLegacyAllowed(stage: StageId, mode: GenerationMode, source: NodeJS.ProcessEnv): void {
  const allowed = allowAnthropicLegacy(source);
  if (mode === "anthropic-legacy" && allowed) return;
  const variable = mode === "anthropic-legacy" ? ALLOW_ANTHROPIC_LEGACY_ENV : GENERATION_MODE_ENV;
  throw new RoutingConfigError(
    variable,
    `Stage "${stage}" is routed to the legacy Anthropic builders, which ${ZERO_ANTHROPIC_RULE}. ` +
      `A legacy run needs both ${GENERATION_MODE_ENV}=anthropic-legacy and ${ALLOW_ANTHROPIC_LEGACY_ENV}=1`
  );
}

function readBaseUrl(source: NodeJS.ProcessEnv): string | null {
  const raw = readString(LLM_BASE_URL_ENV, source);
  if (raw === undefined) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RoutingConfigError(LLM_BASE_URL_ENV, `Invalid value for environment variable ${LLM_BASE_URL_ENV}: expected an http(s) URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new RoutingConfigError(LLM_BASE_URL_ENV, `Invalid value for environment variable ${LLM_BASE_URL_ENV}: expected an http(s) URL`);
  }
  return raw;
}

function allowProseOnSecond(source: NodeJS.ProcessEnv): boolean {
  const raw = readString(ALLOW_PROSE_ON_SECOND_ENV, source);
  if (raw === undefined || raw === "0") return false;
  if (raw === "1") return true;
  throw new RoutingConfigError(ALLOW_PROSE_ON_SECOND_ENV, `Invalid value for environment variable ${ALLOW_PROSE_ON_SECOND_ENV}: expected 1 or 0`);
}

function buildRoute(stage: StageId, spec: RouteSpec, source: NodeJS.ProcessEnv, profiles: LaneProfiles): StageRoute {
  switch (spec.provider) {
    case "anthropic": {
      const tier = LEGACY_TIERS[stage];
      /* ALLOWED_PROVIDERS keeps 'anthropic' off the judge, the only stage
         without a legacy tier. */
      if (tier === undefined) unknownValue(stageEnvVar(stage), stage);
      return { provider: "anthropic", tier, model: resolveModelId(tier, source) };
    }
    case "local": {
      const lane = spec.lane ?? LOCAL_DEFAULT_LANE[stage];
      return { provider: "local", lane, model: profiles[lane].modelAlias };
    }
    case "jev": {
      if (spec.lane === undefined) return { provider: "jev", model: "jev" };
      return { provider: "jev", model: "jev", fallback: { provider: "local", lane: spec.lane, model: profiles[spec.lane].modelAlias } };
    }
    default:
      return { provider: spec.provider, model: spec.provider };
  }
}

export interface ResolveRoutingOptions {
  /** lane profiles; default loadLaneProfiles(source) (reads FORAY_MACHINE_PROFILES_FILE when set) */
  profiles?: LaneProfiles;
  /** the registry 'dossier' must be registered in; default the process registry */
  registry?: StageRegistry;
}

/**
 * The routing table for a source (process.env by default). Throws
 * RoutingConfigError, naming the variable and never its value, when:
 * - a FORAY_STAGE_* value (or FORAY_GENERATION_MODE) is unknown;
 * - a stage is routed `local` (or a jev route falls back to a lane) without
 *   FORAY_LLM_BASE_URL;
 * - the writer is routed to a lane with allowsProse false, unless
 *   FORAY_ALLOW_PROSE_ON_SECOND=1;
 * - research is routed 'dossier' before an implementation registers it;
 * - GV-68: any stage is routed 'anthropic' without both
 *   FORAY_GENERATION_MODE=anthropic-legacy and FORAY_ALLOW_ANTHROPIC_LEGACY=1.
 */
export function resolveRouting(source: NodeJS.ProcessEnv = process.env, options: ResolveRoutingOptions = {}): RoutingTable {
  const profiles = options.profiles ?? loadLaneProfiles(source);
  const registry = options.registry ?? defaultRegistry;
  const { mode, modeSource } = readMode(source);
  const llmBaseUrl = readBaseUrl(source);

  const routes: Partial<Record<StageId, StageRoute>> = {};
  const overridden: StageId[] = [];
  for (const stage of GENERATION_STAGES) {
    const raw = readString(stageEnvVar(stage), source);
    let spec: RouteSpec | undefined;
    if (raw !== undefined) {
      spec = parseSpec(stage, raw);
      overridden.push(stage);
    } else {
      spec = defaultSpec(stage, mode, source);
    }
    if (spec === undefined) continue;
    routes[stage] = buildRoute(stage, spec, source, profiles);
  }

  for (const stage of GENERATION_STAGES) {
    const route = routes[stage];
    if (route === undefined) continue;
    if (route.provider === "anthropic") assertAnthropicLegacyAllowed(stage, mode, source);
    const needsLlm = route.provider === "local" || route.fallback !== undefined;
    if (needsLlm && llmBaseUrl === null) {
      throw new RoutingConfigError(
        LLM_BASE_URL_ENV,
        `Stage "${stage}" is routed to a local lane (${stageEnvVar(stage)} or ${GENERATION_MODE_ENV}=local) but ${LLM_BASE_URL_ENV} is not set`
      );
    }
    if (route.provider === "dossier" && !registry.has(stage, "dossier")) {
      throw new RoutingConfigError(
        stageEnvVar(stage),
        `${stageEnvVar(stage)} routes research to the dossier researcher, which is not built yet (no implementation is registered)`
      );
    }
  }

  const writer = routes.writer;
  if (writer?.provider === "local" && writer.lane !== undefined) {
    const profile: LaneProfile = profiles[writer.lane];
    if (!profile.allowsProse && !allowProseOnSecond(source)) {
      throw new RoutingConfigError(
        stageEnvVar("writer"),
        `${stageEnvVar("writer")} routes the act writer to a lane that does not allow prose (allowsProse: false); ` +
          `prose stays on the Spark unless ${ALLOW_PROSE_ON_SECOND_ENV}=1`
      );
    }
  }

  const anthropicRouted = Object.values(routes).some((r) => r?.provider === "anthropic");
  return Object.freeze({
    mode,
    modeSource,
    anthropicKeyIgnored: !anthropicRouted && readString(ANTHROPIC_API_KEY_ENV, source) !== undefined,
    routes: Object.freeze(routes),
    overridden: Object.freeze(overridden),
    llmBaseUrl,
    llmKeyConfigured: readString(LLM_API_KEY_ENV, source) !== undefined || readString(LLM_API_KEY_FILE_ENV, source) !== undefined,
    profiles
  });
}

/** One stage's route from a source (process.env by default); undefined for an
 * unset 'spine-alt'. */
export function routeFor(stage: StageId, source: NodeJS.ProcessEnv = process.env, options: ResolveRoutingOptions = {}): StageRoute | undefined {
  return resolveRouting(source, options).routes[stage];
}

/**
 * The LiteLLM key: FORAY_LLM_API_KEY, else the trimmed contents of the file
 * FORAY_LLM_API_KEY_FILE names, else undefined. An unreadable or empty key
 * file throws RoutingConfigError naming the variable.
 */
export function resolveLlmApiKey(
  source: NodeJS.ProcessEnv = process.env,
  readFile: (path: string) => string = (p) =>
    // eslint-disable-next-line security/detect-non-literal-fs-filename -- operator-supplied secret path (FORAY_LLM_API_KEY_FILE), read-only.
    fs.readFileSync(p, "utf8")
): string | undefined {
  const direct = readString(LLM_API_KEY_ENV, source);
  if (direct !== undefined) return direct;
  const file = readString(LLM_API_KEY_FILE_ENV, source);
  if (file === undefined) return undefined;
  let text: string;
  try {
    text = readFile(file);
  } catch {
    throw new RoutingConfigError(LLM_API_KEY_FILE_ENV, `${LLM_API_KEY_FILE_ENV} is set but the file could not be read`);
  }
  const key = text.trim();
  if (key.length === 0) throw new RoutingConfigError(LLM_API_KEY_FILE_ENV, `${LLM_API_KEY_FILE_ENV} names an empty file`);
  return key;
}

/** FORAY_LLM_BASE_URL with any user:password, query and fragment removed. */
function redactUrl(raw: string): string {
  const url = new URL(raw);
  url.username = "";
  url.password = "";
  url.search = "";
  url.hash = "";
  return url.toString();
}

export interface RoutingSummary {
  mode: GenerationMode;
  modeSource: RoutingTable["modeSource"];
  /** per routed stage: "stub", "anthropic <model>", "local:<lane> <alias>", "jev (fallback local:<lane>)" */
  stages: Partial<Record<StageId, string>>;
  overridden: StageId[];
  llm: { baseUrl: string | null; keyConfigured: boolean };
}

function describeRoute(route: StageRoute): string {
  switch (route.provider) {
    case "anthropic":
      return `anthropic ${route.model}`;
    case "local":
      return `local:${route.lane} ${route.model}`;
    case "jev":
      return route.fallback ? `jev (fallback local:${route.fallback.lane} ${route.fallback.model})` : "jev";
    default:
      return route.provider;
  }
}

/** Safe to log: mode, per-stage provider/lane/model, the base URL without
 * credentials, and whether a key is configured. Never a key. */
export function routingSummary(routing: RoutingTable = resolveRouting()): RoutingSummary {
  const stages: Partial<Record<StageId, string>> = {};
  for (const stage of GENERATION_STAGES) {
    const route = routing.routes[stage];
    if (route) stages[stage] = describeRoute(route);
  }
  return {
    mode: routing.mode,
    modeSource: routing.modeSource,
    stages,
    overridden: [...routing.overridden],
    llm: { baseUrl: routing.llmBaseUrl === null ? null : redactUrl(routing.llmBaseUrl), keyConfigured: routing.llmKeyConfigured }
  };
}

/* ------------------------------------------------------------------------ */
/* Implementation registry (from W7-02)                                      */
/* ------------------------------------------------------------------------ */

export interface StageBuildContext {
  stage: StageId;
  route: StageRoute;
  /** the lane's profile when the route names a lane */
  profile?: LaneProfile;
  routing: RoutingTable;
}

export interface StageAssignment {
  impl: StageProvider;
  model: string;
  machine?: string;
}

export interface StageImplementation<T = unknown> {
  create(ctx: StageBuildContext): T;
  describe(ctx: StageBuildContext): { model: string; machine?: string };
}

/** Maps (stage, implementation id) to a constructor. A factory registers its
 * built-ins once at module load (GV-37); other cards register their own ids. */
export class StageRegistry {
  private readonly impls = new Map<string, StageImplementation<unknown>>();

  private static key(stage: StageId, implId: StageProvider): string {
    return `${stage}\u0000${implId}`;
  }

  register<T>(stage: StageId, implId: StageProvider, impl: StageImplementation<T>): void {
    if (!(GENERATION_STAGES as readonly string[]).includes(stage)) {
      throw new RoutingConfigError(stageEnvVar(stage), "registerStageImplementation: unknown stage");
    }
    if (!ALLOWED_PROVIDERS[stage].includes(implId)) {
      throw new RoutingConfigError(stageEnvVar(stage), `registerStageImplementation: stage "${stage}" cannot be routed to that implementation id`);
    }
    const key = StageRegistry.key(stage, implId);
    if (this.impls.has(key)) {
      throw new Error(`registerStageImplementation: "${implId}" is already registered for stage "${stage}"`);
    }
    this.impls.set(key, impl as StageImplementation<unknown>);
  }

  has(stage: StageId, implId: StageProvider): boolean {
    return this.impls.has(StageRegistry.key(stage, implId));
  }

  /** Test seam: replaces (or adds) one registration and returns the undo. */
  swap<T>(stage: StageId, implId: StageProvider, impl: StageImplementation<T>): () => void {
    const key = StageRegistry.key(stage, implId);
    const before = this.impls.get(key);
    this.impls.set(key, impl as StageImplementation<unknown>);
    return () => {
      if (before === undefined) this.impls.delete(key);
      else this.impls.set(key, before);
    };
  }

  clear(): void {
    this.impls.clear();
  }

  private context(stage: StageId, routing: RoutingTable): { ctx: StageBuildContext; impl: StageImplementation<unknown> | undefined } | undefined {
    const route = routing.routes[stage];
    if (route === undefined) return undefined;
    const lane = route.lane;
    const ctx: StageBuildContext = { stage, route, routing, ...(lane ? { profile: routing.profiles[lane] } : {}) };
    return { ctx, impl: this.impls.get(StageRegistry.key(stage, route.provider)) };
  }

  instantiate<T>(stage: StageId, routing: RoutingTable): T {
    const variable = stageEnvVar(stage);
    const found = this.context(stage, routing);
    if (found === undefined) {
      throw new RoutingConfigError(variable, `Stage "${stage}" has no route: set ${variable}`);
    }
    if (found.impl === undefined) {
      throw new RoutingConfigError(variable, `${variable}: no implementation is registered for the routed id on stage "${stage}"`);
    }
    return found.impl.create(found.ctx) as T;
  }

  describe(routing: RoutingTable): Partial<Record<StageId, StageAssignment>> {
    const out: Partial<Record<StageId, StageAssignment>> = {};
    for (const stage of GENERATION_STAGES) {
      const found = this.context(stage, routing);
      if (found === undefined) continue;
      const { ctx, impl } = found;
      const described = impl ? impl.describe(ctx) : { model: ctx.route.model, ...(ctx.route.lane ? { machine: ctx.route.lane } : {}) };
      out[stage] = { impl: ctx.route.provider, model: described.model, ...(described.machine ? { machine: described.machine } : {}) };
    }
    return out;
  }
}

const defaultRegistry = new StageRegistry();

/** Registers `impl` as `implId` for `stage` in the process registry. Refuses a
 * duplicate id, an unknown stage, and an id the stage cannot be routed to. */
export function registerStageImplementation<T>(stage: StageId, implId: StageProvider, impl: StageImplementation<T>): void {
  defaultRegistry.register(stage, implId, impl);
}

export function isStageImplementationRegistered(stage: StageId, implId: StageProvider): boolean {
  return defaultRegistry.has(stage, implId);
}

export interface InstantiateOptions {
  source?: NodeJS.ProcessEnv;
  /** a precomputed table; when given, `source` is not read */
  routing?: RoutingTable;
}

/** Builds the implementation the routing table picks for `stage`. Throws
 * RoutingConfigError (naming the variable, never its value) when the stage has
 * no route or its implementation id is not registered. */
export function instantiateStage<T>(stage: StageId, options: InstantiateOptions = {}): T {
  const routing = options.routing ?? resolveRouting(options.source ?? process.env);
  return defaultRegistry.instantiate<T>(stage, routing);
}

/** Per routed stage: {impl, model, machine?} (report provenance, GV-55). */
export function describeStageAssignments(options: InstantiateOptions = {}): Partial<Record<StageId, StageAssignment>> {
  const routing = options.routing ?? resolveRouting(options.source ?? process.env);
  return defaultRegistry.describe(routing);
}

/** Test seam: swap one registration in the process registry (GV-37 swaps
 * 'anthropic' for a sentinel so no test constructs an Anthropic* builder). */
export function __swapStageImplementationForTests<T>(stage: StageId, implId: StageProvider, impl: StageImplementation<T>): () => void {
  return defaultRegistry.swap(stage, implId, impl);
}

/** Test seam: empty the process registry. */
export function __resetStageRegistryForTests(): void {
  defaultRegistry.clear();
}
