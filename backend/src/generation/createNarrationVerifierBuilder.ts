import { instantiateStage } from "../config/stageRouting";
import { ChatNarrationVerifierBuilder } from "./chat/ChatNarrationVerifierBuilder";
import { ensureStageImplementations, localImplementation, plainImplementation } from "./chat/providerRegistry";
import type { NarrationVerifierBuilder } from "./NarrationVerifierBuilder";
import { StubNarrationVerifierBuilder } from "./StubNarrationVerifierBuilder";

/**
 * The verifier stage's built-ins (GV-37): 'stub', 'anthropic' (legacy) and
 * 'local' (ChatNarrationVerifierBuilder). The Anthropic class stays behind a
 * lazy require() so importing this module never pulls in the Anthropic SDK
 * construction path.
 */
const BUILTINS = {
  stub: plainImplementation<NarrationVerifierBuilder>(() => new StubNarrationVerifierBuilder()),
  anthropic: plainImplementation<NarrationVerifierBuilder>(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
    const { AnthropicNarrationVerifierBuilder } = require("./AnthropicNarrationVerifierBuilder") as typeof import("./AnthropicNarrationVerifierBuilder");
    return new AnthropicNarrationVerifierBuilder();
  }),
  local: localImplementation<NarrationVerifierBuilder>((provider, target) => new ChatNarrationVerifierBuilder(provider, target))
};

/**
 * The act verifier the routing table picks (FORAY_STAGE_VERIFIER over
 * FORAY_GENERATION_MODE). Deliberately a SEPARATE factory from
 * createNarrationWriterBuilder(): each call builds its own fresh instance, so
 * `writeNarration.ts` calling both factories can never hand the same builder
 * instance to both roles, whatever the two stages route to. With none of the
 * routing variables set this is today's choice exactly. A 'local' route
 * without FORAY_LLM_BASE_URL throws RoutingConfigError.
 */
export function createNarrationVerifierBuilder(source: NodeJS.ProcessEnv = process.env): NarrationVerifierBuilder {
  ensureStageImplementations("verifier", BUILTINS);
  return instantiateStage<NarrationVerifierBuilder>("verifier", { source });
}
