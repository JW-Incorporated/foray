import { env } from "../config/env";
import type { DeepenActBuilder } from "./DeepenActBuilder";
import { StubDeepenActBuilder } from "./StubDeepenActBuilder";

/**
 * Selects StubDeepenActBuilder when ANTHROPIC_API_KEY is absent,
 * AnthropicDeepenActBuilder otherwise — identical shape to
 * createSpineBuilder() / createPromptUnderstander() / createExternalResearcher(),
 * including the lazy require() so importing this module never pulls in the
 * Anthropic SDK construction path.
 */
export function createDeepenActBuilder(): DeepenActBuilder {
  if (env.anthropicDryRun) {
    return new StubDeepenActBuilder();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
  const { AnthropicDeepenActBuilder } = require("./AnthropicDeepenActBuilder") as typeof import("./AnthropicDeepenActBuilder");
  return new AnthropicDeepenActBuilder();
}
