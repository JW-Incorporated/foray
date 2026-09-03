import { env } from "../config/env";
import type { ContinuityBuilder } from "./ContinuityBuilder";
import { StubContinuityBuilder } from "./StubContinuityBuilder";

/**
 * Selects StubContinuityBuilder when ANTHROPIC_API_KEY is absent,
 * AnthropicContinuityBuilder otherwise — identical shape to
 * createNarrationWriterBuilder() / createDeepenActBuilder(), including
 * the lazy require() so importing this module never pulls in the
 * Anthropic SDK construction path.
 */
export function createContinuityBuilder(): ContinuityBuilder {
  if (env.anthropicDryRun) {
    return new StubContinuityBuilder();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
  const { AnthropicContinuityBuilder } = require("./AnthropicContinuityBuilder") as typeof import("./AnthropicContinuityBuilder");
  return new AnthropicContinuityBuilder();
}
