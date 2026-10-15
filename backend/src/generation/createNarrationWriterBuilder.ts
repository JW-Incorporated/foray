import { instantiateStage } from "../config/stageRouting";
import { ChatNarrationWriterBuilder } from "./chat/ChatNarrationWriterBuilder";
import { ensureStageImplementations, localImplementation, plainImplementation } from "./chat/providerRegistry";
import type { NarrationWriterBuilder } from "./NarrationWriterBuilder";
import { createDraftCritic, readSelfCritique, SelfCritiquingNarrationWriter } from "./selfCritique";
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
 *
 * GV-94 (W7-08): FORAY_WRITER_SELF_CRITIQUE=behind-playhead|all wraps the
 * routed writer in a SelfCritiquingNarrationWriter with the critic
 * FORAY_WRITER_CRITIC names (selfCritique.ts). It refuses, naming the
 * variable, when no critic is named or none is registered under that name,
 * and for the reserved 'cut' mode. Unset (or off), the writer is exactly the
 * routed one: not wrapped.
 */
export function createNarrationWriterBuilder(source: NodeJS.ProcessEnv = process.env): NarrationWriterBuilder {
  ensureStageImplementations("writer", BUILTINS);
  const critique = readSelfCritique(source);
  if (critique.mode === "off") return instantiateStage<NarrationWriterBuilder>("writer", { source });
  const critic = createDraftCritic(critique.critic!, source);
  return new SelfCritiquingNarrationWriter({ inner: instantiateStage<NarrationWriterBuilder>("writer", { source }), critic, mode: critique.mode });
}
