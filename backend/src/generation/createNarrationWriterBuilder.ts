import { instantiateStage } from "../config/stageRouting";
import { ChatNarrationWriterBuilder } from "./chat/ChatNarrationWriterBuilder";
import { ensureStageImplementations, localImplementation, plainImplementation } from "./chat/providerRegistry";
import type { NarrationWriterBuilder } from "./NarrationWriterBuilder";
import { StubNarrationWriterBuilder } from "./StubNarrationWriterBuilder";

/**
 * The writer stage's built-ins (GV-37): 'stub', 'anthropic' (legacy) and
 * 'local' (ChatNarrationWriterBuilder; resolveRouting keeps prose on a lane
 * that allows it). The Anthropic class stays behind a lazy require() so
 * importing this module never pulls in the Anthropic SDK construction path.
 */
const BUILTINS = {
  stub: plainImplementation<NarrationWriterBuilder>(() => new StubNarrationWriterBuilder()),
  anthropic: plainImplementation<NarrationWriterBuilder>(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
    const { AnthropicNarrationWriterBuilder } = require("./AnthropicNarrationWriterBuilder") as typeof import("./AnthropicNarrationWriterBuilder");
    return new AnthropicNarrationWriterBuilder();
  }),
  local: localImplementation<NarrationWriterBuilder>((provider, target) => new ChatNarrationWriterBuilder(provider, target))
};

/**
 * The act writer the routing table picks (FORAY_STAGE_WRITER over
 * FORAY_GENERATION_MODE). With none of the routing variables set this is
 * today's choice exactly: Stub without ANTHROPIC_API_KEY, Anthropic with it.
 * A 'local' route without FORAY_LLM_BASE_URL throws RoutingConfigError.
 */
export function createNarrationWriterBuilder(source: NodeJS.ProcessEnv = process.env): NarrationWriterBuilder {
  ensureStageImplementations("writer", BUILTINS);
  return instantiateStage<NarrationWriterBuilder>("writer", { source });
}
