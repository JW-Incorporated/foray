import { instantiateStage, resolveRouting, RoutingConfigError, stageEnvVar } from "../config/stageRouting";
import { BestOfTwoSpineBuilder, createSpineJudge, readSpineBestOf, SPINE_BEST_OF_ENV } from "./bestOfSpine";
import { ChatSpineBuilder } from "./chat/ChatSpineBuilder";
import { ensureStageImplementations, localImplementation, plainImplementation } from "./chat/providerRegistry";
import type { SpineBuilder } from "./SpineBuilder";
import { StubSpineBuilder } from "./StubSpineBuilder";

/**
 * The spine stage's built-ins (GV-37): 'stub', 'anthropic' (legacy) and
 * 'local' (ChatSpineBuilder on the routed lane). The Anthropic class stays
 * behind a lazy require() so importing this module never pulls in the
 * Anthropic SDK construction path.
 */
const BUILTINS = {
  stub: plainImplementation<SpineBuilder>(() => new StubSpineBuilder()),
  anthropic: plainImplementation<SpineBuilder>(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
    const { AnthropicSpineBuilder } = require("./AnthropicSpineBuilder") as typeof import("./AnthropicSpineBuilder");
    return new AnthropicSpineBuilder();
  }),
  local: localImplementation<SpineBuilder>((provider, target) => new ChatSpineBuilder(provider, target))
};

/**
 * The spine builder the routing table picks (config/stageRouting.ts,
 * FORAY_STAGE_SPINE over FORAY_GENERATION_MODE). With none of the routing
 * variables set this is today's choice exactly: StubSpineBuilder without
 * ANTHROPIC_API_KEY, AnthropicSpineBuilder with it. A stage routed 'local'
 * without FORAY_LLM_BASE_URL throws RoutingConfigError; it never falls back to
 * the Stub. `source` is process.env unless a test injects one.
 *
 * GV-91 (W7-07): FORAY_SPINE_BEST_OF=2 wraps the 'spine' builder and the
 * 'spine-alt' builder (FORAY_STAGE_SPINE_ALT, which has no default) in a
 * BestOfTwoSpineBuilder with the judge FORAY_SPINE_JUDGE names and a grace of
 * FORAY_SPINE_BEST_OF_GRACE_MS. It refuses, naming the variable, when
 * spine-alt is unset or routed 'anthropic', or when no judge is registered
 * under that name. Unset (or 1), the builder is exactly the routed one.
 */
export function createSpineBuilder(source: NodeJS.ProcessEnv = process.env): SpineBuilder {
  ensureStageImplementations("spine", BUILTINS);
  const config = readSpineBestOf(source);
  if (config.bestOf === 1) return instantiateStage<SpineBuilder>("spine", { source });

  const altVar = stageEnvVar("spine-alt");
  const routing = resolveRouting(source);
  const alt = routing.routes["spine-alt"];
  if (alt === undefined) {
    throw new RoutingConfigError(altVar, `${SPINE_BEST_OF_ENV}=2 needs ${altVar}: the second spine sample has no default route`);
  }
  if (alt.provider === "anthropic") {
    throw new RoutingConfigError(altVar, `${SPINE_BEST_OF_ENV}=2 refuses an 'anthropic' ${altVar}: the second sample is a local lane`);
  }
  const judge = createSpineJudge(config.judge!, source);
  ensureStageImplementations("spine-alt", BUILTINS);
  return new BestOfTwoSpineBuilder({
    primary: instantiateStage<SpineBuilder>("spine", { routing }),
    secondary: instantiateStage<SpineBuilder>("spine-alt", { routing }),
    judge,
    graceMs: config.graceMs!
  });
}
