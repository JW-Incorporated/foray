import { instantiateStage } from "../config/stageRouting";
import { ensureStageImplementations, plainImplementation } from "./chat/providerRegistry";
import { DossierExternalResearcher } from "./DossierExternalResearcher";
import type { ExternalResearcher } from "./ExternalResearcher";
import { NullExternalResearcher } from "./NullExternalResearcher";
import { StubExternalResearcher } from "./StubExternalResearcher";

/**
 * The research stage's built-ins (GV-37): 'stub', 'anthropic' (legacy web
 * research), 'none' (NullExternalResearcher, the local-mode default) and
 * 'dossier' (GV-69: DossierExternalResearcher, outside facts from the local
 * dossiers in generationFlags' dossierDir(), no network; only an explicit
 * FORAY_STAGE_RESEARCH=dossier routes here). Research has no 'local' route.
 * The Anthropic class stays behind a
 * lazy require() so importing this module never pulls in the Anthropic SDK
 * construction path.
 */
const BUILTINS = {
  stub: plainImplementation<ExternalResearcher>(() => new StubExternalResearcher()),
  anthropic: plainImplementation<ExternalResearcher>(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- intentional sync lazy-load, see createEnricher.ts for the identical rationale.
    const { AnthropicExternalResearcher } = require("./AnthropicExternalResearcher") as typeof import("./AnthropicExternalResearcher");
    return new AnthropicExternalResearcher();
  }),
  none: plainImplementation<ExternalResearcher>(() => new NullExternalResearcher()),
  dossier: plainImplementation<ExternalResearcher>(() => new DossierExternalResearcher())
};

/* Registered when the module loads, not only when the factory runs:
   resolveRouting() refuses 'dossier' while the process registry has no entry
   for it, and real runs resolve the routing table (generateForays' run table
   and --stage-provider check, runPipeline's routing and createPromptUnderstander)
   before createExternalResearcher() is ever called. runPipeline imports this
   module, so FORAY_STAGE_RESEARCH=dossier resolves from the CLI. The call in
   the factory stays, idempotent, so a reset registry is restored. */
ensureStageImplementations("research", BUILTINS);

/**
 * The external researcher the routing table picks (FORAY_STAGE_RESEARCH over
 * FORAY_GENERATION_MODE). With none of the routing variables set this is
 * today's choice exactly: Stub without ANTHROPIC_API_KEY, Anthropic with it.
 *
 * GV-61: the pipeline builds ONE researcher with this and hands it to both
 * §4.2's shape research and the evidence gatherer, so a single route decides
 * whether a run reaches outside at all. FORAY_STAGE_RESEARCH=dossier builds
 * the dossier researcher (GV-69), registered at module load and again here;
 * resolveRouting still refuses 'dossier' in a registry where it is not
 * registered.
 */
export function createExternalResearcher(source: NodeJS.ProcessEnv = process.env): ExternalResearcher {
  ensureStageImplementations("research", BUILTINS);
  return instantiateStage<ExternalResearcher>("research", { source });
}
