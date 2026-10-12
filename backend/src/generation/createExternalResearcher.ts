import { instantiateStage } from "../config/stageRouting";
import { ensureStageImplementations, plainImplementation } from "./chat/providerRegistry";
import type { ExternalResearcher } from "./ExternalResearcher";
import { NullExternalResearcher } from "./NullExternalResearcher";
import { StubExternalResearcher } from "./StubExternalResearcher";

/**
 * The research stage's built-ins (GV-37): 'stub', 'anthropic' (legacy web
 * research) and 'none' (NullExternalResearcher, the local-mode default).
 * Research has no 'local' route, and 'dossier' is refused by resolveRouting
 * as not built until GV-69 registers it. The Anthropic class stays behind a
 * lazy require() so importing this module never pulls in the Anthropic SDK
 * construction path.
 */
const BUILTINS = {
  stub: plainImplementation<ExternalResearcher>(() => new StubExternalResearcher()),
  anthropic: plainImplementation<ExternalResearcher>(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
    const { AnthropicExternalResearcher } = require("./AnthropicExternalResearcher") as typeof import("./AnthropicExternalResearcher");
    return new AnthropicExternalResearcher();
  }),
  none: plainImplementation<ExternalResearcher>(() => new NullExternalResearcher())
};

/**
 * The external researcher the routing table picks (FORAY_STAGE_RESEARCH over
 * FORAY_GENERATION_MODE). With none of the routing variables set this is
 * today's choice exactly: Stub without ANTHROPIC_API_KEY, Anthropic with it.
 */
export function createExternalResearcher(source: NodeJS.ProcessEnv = process.env): ExternalResearcher {
  ensureStageImplementations("research", BUILTINS);
  return instantiateStage<ExternalResearcher>("research", { source });
}
