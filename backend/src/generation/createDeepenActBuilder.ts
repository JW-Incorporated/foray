import { instantiateStage } from "../config/stageRouting";
import { ChatDeepenActBuilder } from "./chat/ChatDeepenActBuilder";
import { ensureStageImplementations, localImplementation, plainImplementation } from "./chat/providerRegistry";
import type { DeepenActBuilder } from "./DeepenActBuilder";
import { StubDeepenActBuilder } from "./StubDeepenActBuilder";

/**
 * The deepen stage's built-ins (GV-37): 'stub', 'anthropic' (legacy) and
 * 'local' (ChatDeepenActBuilder, the second box by default). The Anthropic
 * class stays behind a lazy require() so importing this module never pulls in
 * the Anthropic SDK construction path.
 */
const BUILTINS = {
  stub: plainImplementation<DeepenActBuilder>(() => new StubDeepenActBuilder()),
  anthropic: plainImplementation<DeepenActBuilder>(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
    const { AnthropicDeepenActBuilder } = require("./AnthropicDeepenActBuilder") as typeof import("./AnthropicDeepenActBuilder");
    return new AnthropicDeepenActBuilder();
  }),
  local: localImplementation<DeepenActBuilder>((provider, target) => new ChatDeepenActBuilder(provider, target))
};

/**
 * The deepen-act builder the routing table picks (FORAY_STAGE_DEEPEN over
 * FORAY_GENERATION_MODE). With none of the routing variables set this is
 * today's choice exactly: Stub without ANTHROPIC_API_KEY, Anthropic with it.
 * A 'local' route without FORAY_LLM_BASE_URL throws RoutingConfigError.
 */
export function createDeepenActBuilder(source: NodeJS.ProcessEnv = process.env): DeepenActBuilder {
  ensureStageImplementations("deepen", BUILTINS);
  return instantiateStage<DeepenActBuilder>("deepen", { source });
}
