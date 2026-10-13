import { env } from "../config/env";
import {
  instantiateStage,
  resolveRouting,
  RoutingConfigError,
  stageEnvVar,
  type StageBuildContext,
  type StageImplementation,
  type StageRoute
} from "../config/stageRouting";
import type { ClarityResult, IntentUnderstanding } from "../types/generation";
import { ChatPromptUnderstander } from "./chat/ChatPromptUnderstander";
import { ensureStageImplementations, localImplementation, plainImplementation } from "./chat/providerRegistry";
import { createJevClient } from "./jevClient";
import { JevPromptUnderstander } from "./JevPromptUnderstander";
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

/** What the clarity stage's 'jev' implementation builds: a wrapper that puts
 * Jev's two yes/no questions in front of the text understander the routing
 * table picks for the rest of §4.1 (its fallback). */
export type JevClarityWrapper = (fallback: PromptUnderstander) => PromptUnderstander;

/** The variable a 'jev' clarity route without a key names (JEV_KEY_FILE is
 * read too; config/env.ts readJevApiKey). */
const JEV_KEY_ENV = "JEV_API_KEY";

/**
 * GV-49: the 'jev' implementation of the understand-clarity stage
 * (FORAY_STAGE_UNDERSTAND_CLARITY=jev, or jev:<lane> for GV-47's Qwen judge on
 * <lane> behind Jev when Jev is down). The Jev client is GV-20's, built by
 * createJevClient from this route, so the jev / jev:<lane> semantics are the
 * judge stage's exactly. Without a Jev key (JEV_API_KEY or JEV_KEY_FILE) it
 * throws RoutingConfigError naming JEV_API_KEY: a misrouted stage fails at
 * pipeline start and never quietly answers with the default understander.
 */
const JEV_CLARITY: StageImplementation<JevClarityWrapper> = {
  create: (ctx: StageBuildContext) => {
    if (env.jevApiKey === undefined) {
      throw new RoutingConfigError(
        JEV_KEY_ENV,
        `${stageEnvVar("understand.clarity")} routes the clarity check to Jev but no Jev key is set (${JEV_KEY_ENV} or JEV_KEY_FILE)`
      );
    }
    const jev = createJevClient({ routing: { ...ctx.routing, routes: { ...ctx.routing.routes, judge: ctx.route } } });
    return (fallback) => new JevPromptUnderstander(jev, fallback);
  },
  describe: (ctx: StageBuildContext) => ({
    model: ctx.route.model,
    ...(ctx.route.fallback ? { machine: ctx.route.fallback.lane } : {})
  })
};

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
 * GV-49: FORAY_STAGE_UNDERSTAND_CLARITY=jev (or jev:<lane>) returns a
 * JevPromptUnderstander over that intent understander: one Jev request with
 * two yes/no questions decides clarity, and the intent understander answers
 * when Jev says yes or is unavailable. Without a Jev key it throws
 * RoutingConfigError naming JEV_API_KEY.
 *
 * With none of the routing variables set this is today's choice exactly:
 * StubPromptUnderstander without ANTHROPIC_API_KEY, AnthropicPromptUnderstander
 * with it. A 'local' route without FORAY_LLM_BASE_URL throws
 * RoutingConfigError; it never falls back to the Stub. `source` is
 * process.env unless a test injects one.
 */
export function createPromptUnderstander(source: NodeJS.ProcessEnv = process.env): PromptUnderstander {
  for (const stage of UNDERSTAND_STAGES) ensureStageImplementations(stage, BUILTINS);
  ensureStageImplementations("understand.clarity", { jev: JEV_CLARITY });
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
  /* GV-49: a 'jev' clarity route wraps the intent understander, which is
     Jev's fallback for clarity and still answers extractIntent. */
  if (routing.routes["understand.clarity"]?.provider === "jev") {
    return instantiateStage<JevClarityWrapper>("understand.clarity", { routing })(intent);
  }
  if (sameRoute(routing.routes["understand.clarity"], intentRoute)) return intent;
  const clarity = instantiateStage<PromptUnderstander>("understand.clarity", { routing });
  return new SplitPromptUnderstander(clarity, intent);
}
