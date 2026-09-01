import { env } from "../config/env";
import type { PromptUnderstander } from "./PromptUnderstander";
import { StubPromptUnderstander } from "./StubPromptUnderstander";

/**
 * Selects StubPromptUnderstander when ANTHROPIC_API_KEY is absent,
 * AnthropicPromptUnderstander otherwise — identical shape to
 * createEnricher() (backend/src/enrich/createEnricher.ts), including the
 * lazy require() so importing this module never pulls in the Anthropic SDK
 * construction path.
 */
export function createPromptUnderstander(): PromptUnderstander {
  if (env.anthropicDryRun) {
    return new StubPromptUnderstander();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
  const { AnthropicPromptUnderstander } = require("./AnthropicPromptUnderstander") as typeof import("./AnthropicPromptUnderstander");
  return new AnthropicPromptUnderstander();
}
