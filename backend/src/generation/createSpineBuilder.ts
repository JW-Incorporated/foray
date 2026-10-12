import { instantiateStage } from "../config/stageRouting";
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
 */
export function createSpineBuilder(source: NodeJS.ProcessEnv = process.env): SpineBuilder {
  ensureStageImplementations("spine", BUILTINS);
  return instantiateStage<SpineBuilder>("spine", { source });
}
