import { instantiateStage, jevKeyConfigured, resolveRouting, RoutingConfigError, type StageBuildContext, type StageImplementation } from "../config/stageRouting";
import { ChatNarrationVerifierBuilder } from "./chat/ChatNarrationVerifierBuilder";
import { ensureStageImplementations, localImplementation, plainImplementation } from "./chat/providerRegistry";
import { readGateConfig } from "./gateConfig";
import { createJevClient } from "./jevClient";
import { JevNarrationVerifierBuilder } from "./JevNarrationVerifierBuilder";
import type { NarrationVerifierBuilder } from "./NarrationVerifierBuilder";
import { StubNarrationVerifierBuilder } from "./StubNarrationVerifierBuilder";

/** The variable a 'jev' verifier route without a Jev key is reported against. */
export const JEV_API_KEY_ENV = "JEV_API_KEY";

/**
 * GV-51: the 'jev' verifier (JevNarrationVerifierBuilder). Its client is
 * createJevClient over the VERIFIER's route (not the judge stage's), so
 * FORAY_STAGE_VERIFIER=jev is Jev alone and jev:<lane> is Jev with the Qwen
 * judge on <lane> as its fallback (GV-47). The support thresholds come from
 * the gate table (FORAY_SUPPORT_MIN_P_JEV / _QWEN), read here, once per
 * builder, so the builder itself never reads process.env.
 */
const jevImplementation: StageImplementation<NarrationVerifierBuilder> = {
  create: (ctx: StageBuildContext) =>
    new JevNarrationVerifierBuilder({
      client: createJevClient({ routing: { ...ctx.routing, routes: { ...ctx.routing.routes, judge: ctx.route } } }),
      gates: readGateConfig()
    }),
  describe: (ctx: StageBuildContext) => ({ model: ctx.route.model, ...(ctx.route.fallback ? { machine: ctx.route.fallback.lane } : {}) })
};

/**
 * The verifier stage's built-ins (GV-37): 'stub', 'anthropic' (legacy) and
 * 'local' (ChatNarrationVerifierBuilder), and GV-51's 'jev'. The Anthropic
 * class stays behind a lazy require() so importing this module never pulls
 * in the Anthropic SDK construction path.
 */
const BUILTINS = {
  stub: plainImplementation<NarrationVerifierBuilder>(() => new StubNarrationVerifierBuilder()),
  anthropic: plainImplementation<NarrationVerifierBuilder>(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
    const { AnthropicNarrationVerifierBuilder } = require("./AnthropicNarrationVerifierBuilder") as typeof import("./AnthropicNarrationVerifierBuilder");
    return new AnthropicNarrationVerifierBuilder();
  }),
  local: localImplementation<NarrationVerifierBuilder>((provider, target) => new ChatNarrationVerifierBuilder(provider, target)),
  jev: jevImplementation
};

/**
 * The act verifier the routing table picks (FORAY_STAGE_VERIFIER over
 * FORAY_GENERATION_MODE). Deliberately a SEPARATE factory from
 * createNarrationWriterBuilder(): each call builds its own fresh instance, so
 * `writeNarration.ts` calling both factories can never hand the same builder
 * instance to both roles, whatever the two stages route to. With none of the
 * routing variables set this is today's choice exactly. A 'local' route
 * without FORAY_LLM_BASE_URL throws RoutingConfigError; so does a 'jev'
 * route (GV-51) without a Jev key (JEV_API_KEY or JEV_KEY_FILE), naming
 * JEV_API_KEY, rather than a verifier that could never confirm anything.
 */
export function createNarrationVerifierBuilder(source: NodeJS.ProcessEnv = process.env): NarrationVerifierBuilder {
  ensureStageImplementations("verifier", BUILTINS);
  const routing = resolveRouting(source);
  if (routing.routes.verifier?.provider === "jev" && !jevKeyConfigured(source)) {
    throw new RoutingConfigError(JEV_API_KEY_ENV, `FORAY_STAGE_VERIFIER routes the verifier to jev but ${JEV_API_KEY_ENV} (or JEV_KEY_FILE) is not set`);
  }
  return instantiateStage<NarrationVerifierBuilder>("verifier", { routing });
}
