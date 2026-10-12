import { instantiateStage } from "../config/stageRouting";
import { ChatContinuityBuilder } from "./chat/ChatContinuityBuilder";
import { ensureStageImplementations, localImplementation, plainImplementation } from "./chat/providerRegistry";
import type { ContinuityBuilder } from "./ContinuityBuilder";
import { StubContinuityBuilder } from "./StubContinuityBuilder";

/**
 * The continuity stage's built-ins (GV-37): 'stub', 'anthropic' (legacy) and
 * 'local' (ChatContinuityBuilder on the routed lane). The Anthropic class
 * stays behind a lazy require() so importing this module never pulls in the
 * Anthropic SDK construction path.
 */
const BUILTINS = {
  stub: plainImplementation<ContinuityBuilder>(() => new StubContinuityBuilder()),
  anthropic: plainImplementation<ContinuityBuilder>(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
    const { AnthropicContinuityBuilder } = require("./AnthropicContinuityBuilder") as typeof import("./AnthropicContinuityBuilder");
    return new AnthropicContinuityBuilder();
  }),
  local: localImplementation<ContinuityBuilder>((provider, target) => new ChatContinuityBuilder(provider, target))
};

/**
 * The continuity builder the routing table picks (FORAY_STAGE_CONTINUITY over
 * FORAY_GENERATION_MODE). With none of the routing variables set this is
 * today's choice exactly: Stub without ANTHROPIC_API_KEY, Anthropic with it.
 * A 'local' route without FORAY_LLM_BASE_URL throws RoutingConfigError.
 */
export function createContinuityBuilder(source: NodeJS.ProcessEnv = process.env): ContinuityBuilder {
  ensureStageImplementations("continuity", BUILTINS);
  return instantiateStage<ContinuityBuilder>("continuity", { source });
}
