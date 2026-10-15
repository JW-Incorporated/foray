import {
  isStageImplementationRegistered,
  registerStageImplementation,
  resolveLlmApiKey,
  RoutingConfigError,
  LLM_BASE_URL_ENV,
  type RoutingTable,
  type StageBuildContext,
  type StageId,
  type StageImplementation,
  type StageProvider
} from "../../config/stageRouting";
import { DEFAULT_LANE_PROFILES, type LaneProfiles } from "../../config/machineProfiles";
import type { ChatProvider } from "./ChatProvider";
import { LaneScheduledProvider } from "./laneScheduler";
import { OpenAICompatChatProvider } from "./openAICompatProvider";
import type { StructuredTarget } from "./askStructured";
import { targetFor } from "./targetFor";

/**
 * GV-37 (docs/roadmap/generation-v2.md, from W2-08 and the factory half of
 * W7-02; covers R2-21, HW-12, GP-06): the one place a stage factory gets its
 * ChatProvider, and the helpers the seven create*.ts factories use to register
 * their built-in implementations (stub, anthropic, local) in the stage
 * registry (config/stageRouting.ts, GV-03).
 *
 * ONE PROVIDER PER PROCESS. getChatProvider lazily builds one
 * OpenAICompatChatProvider (LiteLLM's OpenAI-compatible endpoint) from
 * FORAY_LLM_BASE_URL and the key (FORAY_LLM_API_KEY or FORAY_LLM_API_KEY_FILE,
 * resolveLlmApiKey), and hands the same instance to every local stage. A
 * call with a different base URL, key or lane profiles replaces the cached
 * instance. __setChatProviderForTests swaps in a scripted provider (and
 * resets); a test provider is handed out as given, unscheduled.
 *
 * GV-93: the instance is the OpenAI-compatible client wrapped in the lane
 * scheduler (chat/laneScheduler.ts: per-lane slots from the lane profiles,
 * critical-path calls first, queueMs, the GV-90 seconds caps), and the client
 * tags every request `user: 'foray-generation'` (FORAY_REQUEST_USER). Only
 * local routes reach this provider, so the anthropic and stub paths are
 * unchanged.
 *
 * NO NETWORK HERE. Building the provider opens no connection; the first byte
 * goes out when a stage calls complete(). Errors name the variable, never its
 * value (the URL may carry credentials).
 */

let testProvider: ChatProvider | undefined;
let cached: { signature: string; provider: ChatProvider } | undefined;

/** GV-93: the `user` every Foray request carries, so LiteLLM can tell Foray's
 * requests from the owners' terminals (and a Foray-only key can be scoped). */
export const FORAY_REQUEST_USER = "foray-generation";

export interface ChatProviderConfig {
  /** FORAY_LLM_BASE_URL (already validated by resolveRouting). */
  baseUrl: string | null;
  /** The LiteLLM key; absent means an unauthenticated server. */
  apiKey: string | undefined;
  /** GV-93: the lane profiles the scheduler sizes its slots from (the routing
   * table's; DEFAULT_LANE_PROFILES when absent). */
  profiles?: LaneProfiles;
}

/** The process's ChatProvider for `config`. Throws RoutingConfigError naming
 * FORAY_LLM_BASE_URL when it is not set (resolveRouting already refuses a
 * local route without it, so this is a second line). */
export function getChatProvider(config: ChatProviderConfig): ChatProvider {
  if (testProvider !== undefined) return testProvider;
  if (config.baseUrl === null || config.baseUrl.trim() === "") {
    throw new RoutingConfigError(LLM_BASE_URL_ENV, `A stage is routed to a local lane but ${LLM_BASE_URL_ENV} is not set`);
  }
  const apiKey = config.apiKey ?? "";
  const profiles = config.profiles ?? DEFAULT_LANE_PROFILES;
  const signature = `${config.baseUrl}\u0000${apiKey}\u0000${JSON.stringify(profiles)}`;
  if (cached === undefined || cached.signature !== signature) {
    const client = new OpenAICompatChatProvider({ baseUrl: config.baseUrl, apiKey, name: "litellm", user: FORAY_REQUEST_USER });
    cached = { signature, provider: new LaneScheduledProvider(client, { profiles }) };
  }
  return cached.provider;
}

/** The ChatProvider for a resolved routing table: its FORAY_LLM_BASE_URL and
 * the key read from `source` (process.env by default). */
export function chatProviderFor(routing: RoutingTable, source: NodeJS.ProcessEnv = process.env): ChatProvider {
  if (testProvider !== undefined) return testProvider;
  return getChatProvider({ baseUrl: routing.llmBaseUrl, apiKey: resolveLlmApiKey(source), profiles: routing.profiles });
}

/** Test seam: every local stage gets `provider` until reset with undefined,
 * which also drops the cached real provider. */
export function __setChatProviderForTests(provider: ChatProvider | undefined): void {
  testProvider = provider;
  cached = undefined;
}

/* ------------------------------------------------------------------------ */
/* The factories' built-in registrations                                     */
/* ------------------------------------------------------------------------ */

/** A built-in that needs nothing from the route (stub, none, the legacy
 * Anthropic builders, which read their tier through models.ts themselves). */
export function plainImplementation<T>(build: () => T): StageImplementation<T> {
  return {
    create: () => build(),
    describe: (ctx: StageBuildContext) => ({ model: ctx.route.model })
  };
}

/** The 'local' built-in: a Chat* builder on the process's ChatProvider with
 * the route's StructuredTarget (targetFor: providerName local:<lane>, the
 * lane's model alias and structured-output mode). */
export function localImplementation<T>(build: (provider: ChatProvider, target: StructuredTarget) => T): StageImplementation<T> {
  return {
    create: (ctx: StageBuildContext) => {
      if (ctx.profile === undefined) throw new Error(`stage "${ctx.stage}": a local route without a lane profile`);
      return build(chatProviderFor(ctx.routing), targetFor(ctx.route, ctx.profile));
    },
    describe: (ctx: StageBuildContext) => ({ model: ctx.route.model, ...(ctx.route.lane ? { machine: ctx.route.lane } : {}) })
  };
}

/** Registers each implementation id for `stage` that is not registered yet.
 * Idempotent, so a factory calls it on every call: a registration a test
 * swapped in (and undid) or a reset registry is restored, and a registration
 * another card made under its own id is never touched. */
export function ensureStageImplementations(stage: StageId, impls: Partial<Record<StageProvider, StageImplementation<unknown>>>): void {
  for (const id of Object.keys(impls) as StageProvider[]) {
    const impl = impls[id];
    if (impl !== undefined && !isStageImplementationRegistered(stage, id)) registerStageImplementation(stage, id, impl);
  }
}
