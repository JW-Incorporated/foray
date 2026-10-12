import {
  instantiateStage,
  resolveRouting,
  RoutingConfigError,
  stageEnvVar,
  type StageRoute
} from "../config/stageRouting";
import type { ClarityResult, IntentUnderstanding } from "../types/generation";
import { ChatPromptUnderstander } from "./chat/ChatPromptUnderstander";
import { ensureStageImplementations, localImplementation, plainImplementation } from "./chat/providerRegistry";
import type { PromptUnderstandContext, PromptUnderstander } from "./PromptUnderstander";
import { StubPromptUnderstander } from "./StubPromptUnderstander";

/**
 * The understander's built-ins (GV-37): 'stub', 'anthropic' (legacy) and
 * 'local' (ChatPromptUnderstander on the routed lane), registered for each of
 * the three understand stages. The Anthropic class stays behind a lazy
 * require() so importing this module never pulls in the Anthropic SDK
 * construction path.
 */
const BUILTINS = {
  stub: plainImplementation<PromptUnderstander>(() => new StubPromptUnderstander()),
  anthropic: plainImplementation<PromptUnderstander>(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
    const { AnthropicPromptUnderstander } = require("./AnthropicPromptUnderstander") as typeof import("./AnthropicPromptUnderstander");
    return new AnthropicPromptUnderstander();
  }),
  local: localImplementation<PromptUnderstander>((provider, target) => new ChatPromptUnderstander(provider, target))
};

const UNDERSTAND_STAGES = ["understand.clarity", "understand.intent", "understand.title"] as const;

function sameRoute(a: StageRoute | undefined, b: StageRoute | undefined): boolean {
  return a !== undefined && b !== undefined && a.provider === b.provider && a.lane === b.lane && a.model === b.model;
}

/**
 * Clarity from one implementation, intent (and its title re-case) from
 * another: what a FORAY_STAGE_UNDERSTAND_CLARITY override that differs from
 * the intent route builds. Each half keeps its own providerName on the cost
 * events it records.
 */
class SplitPromptUnderstander implements PromptUnderstander {
  readonly providerName: string;

  constructor(
    private readonly clarity: PromptUnderstander,
    private readonly intent: PromptUnderstander
  ) {
    this.providerName = `${intent.providerName} (clarity: ${clarity.providerName})`;
  }

  assessClarity(prompt: string, ctx: PromptUnderstandContext): Promise<ClarityResult> {
    return this.clarity.assessClarity(prompt, ctx);
  }

  extractIntent(prompt: string, ctx: PromptUnderstandContext): Promise<IntentUnderstanding> {
    return this.intent.extractIntent(prompt, ctx);
  }
}

/**
 * The prompt understander the routing table picks. The intent route
 * (FORAY_STAGE_UNDERSTAND_INTENT over FORAY_GENERATION_MODE) builds it; a
 * clarity route that differs from it gets its own implementation for
 * assessClarity. The title re-case runs inside extractIntent, so the title
 * route must equal the intent route until a card splits it out: a different
 * one throws RoutingConfigError naming FORAY_STAGE_UNDERSTAND_TITLE rather
 * than being silently ignored.
 *
 * With none of the routing variables set this is today's choice exactly:
 * StubPromptUnderstander without ANTHROPIC_API_KEY, AnthropicPromptUnderstander
 * with it. A 'local' route without FORAY_LLM_BASE_URL throws
 * RoutingConfigError; it never falls back to the Stub. `source` is
 * process.env unless a test injects one.
 */
export function createPromptUnderstander(source: NodeJS.ProcessEnv = process.env): PromptUnderstander {
  for (const stage of UNDERSTAND_STAGES) ensureStageImplementations(stage, BUILTINS);
  const routing = resolveRouting(source);
  const intentRoute = routing.routes["understand.intent"];
  if (!sameRoute(routing.routes["understand.title"], intentRoute)) {
    const variable = stageEnvVar("understand.title");
    throw new RoutingConfigError(
      variable,
      `${variable} must route the title re-case with ${stageEnvVar("understand.intent")}: the re-case runs inside intent extraction`
    );
  }
  const intent = instantiateStage<PromptUnderstander>("understand.intent", { routing });
  if (sameRoute(routing.routes["understand.clarity"], intentRoute)) return intent;
  const clarity = instantiateStage<PromptUnderstander>("understand.clarity", { routing });
  return new SplitPromptUnderstander(clarity, intent);
}
