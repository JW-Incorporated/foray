import { env } from "../config/env";
import type { NarrationVerifierBuilder } from "./NarrationVerifierBuilder";
import { StubNarrationVerifierBuilder } from "./StubNarrationVerifierBuilder";

/**
 * Selects StubNarrationVerifierBuilder when ANTHROPIC_API_KEY is absent,
 * AnthropicNarrationVerifierBuilder otherwise. Deliberately a SEPARATE
 * factory from createNarrationWriterBuilder() — each returns its own
 * fresh instance, so `writeNarration.ts` calling both factories can never
 * end up handing the same builder instance to both roles.
 */
export function createNarrationVerifierBuilder(): NarrationVerifierBuilder {
  if (env.anthropicDryRun) {
    return new StubNarrationVerifierBuilder();
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
  const { AnthropicNarrationVerifierBuilder } = require("./AnthropicNarrationVerifierBuilder") as typeof import("./AnthropicNarrationVerifierBuilder");
  return new AnthropicNarrationVerifierBuilder();
}
