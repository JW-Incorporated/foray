import { env } from "../config/env";
import type { NarrationWriterBuilder } from "./NarrationWriterBuilder";
import { StubNarrationWriterBuilder } from "./StubNarrationWriterBuilder";

/**
 * Selects StubNarrationWriterBuilder when ANTHROPIC_API_KEY is absent,
 * AnthropicNarrationWriterBuilder otherwise — identical shape to
 * createSpineBuilder() / createDeepenActBuilder(), including the lazy
 * require() so importing this module never pulls in the Anthropic SDK
 * construction path.
 */
export function createNarrationWriterBuilder(): NarrationWriterBuilder {
  if (env.anthropicDryRun) {
    return new StubNarrationWriterBuilder();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
  const { AnthropicNarrationWriterBuilder } = require("./AnthropicNarrationWriterBuilder") as typeof import("./AnthropicNarrationWriterBuilder");
  return new AnthropicNarrationWriterBuilder();
}
