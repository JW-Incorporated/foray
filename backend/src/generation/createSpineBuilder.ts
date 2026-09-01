import { env } from "../config/env";
import type { SpineBuilder } from "./SpineBuilder";
import { StubSpineBuilder } from "./StubSpineBuilder";

/**
 * Selects StubSpineBuilder when ANTHROPIC_API_KEY is absent,
 * AnthropicSpineBuilder otherwise — identical shape to
 * createPromptUnderstander() / createExternalResearcher(), including the
 * lazy require() so importing this module never pulls in the Anthropic
 * SDK construction path.
 */
export function createSpineBuilder(): SpineBuilder {
  if (env.anthropicDryRun) {
    return new StubSpineBuilder();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
  const { AnthropicSpineBuilder } = require("./AnthropicSpineBuilder") as typeof import("./AnthropicSpineBuilder");
  return new AnthropicSpineBuilder();
}
