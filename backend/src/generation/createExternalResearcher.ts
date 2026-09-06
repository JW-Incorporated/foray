import { env } from "../config/env";
import type { ExternalResearcher } from "./ExternalResearcher";
import { StubExternalResearcher } from "./StubExternalResearcher";

/**
 * Selects StubExternalResearcher when ANTHROPIC_API_KEY is absent,
 * AnthropicExternalResearcher otherwise — identical shape to
 * createPromptUnderstander() / createEnricher(), including the lazy
 * require() so importing this module never pulls in the Anthropic SDK
 * construction path.
 */
export function createExternalResearcher(): ExternalResearcher {
  if (env.anthropicDryRun) {
    return new StubExternalResearcher();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
  const { AnthropicExternalResearcher } = require("./AnthropicExternalResearcher") as typeof import("./AnthropicExternalResearcher");
  return new AnthropicExternalResearcher();
}
