import type { LaneProfile } from "../../config/machineProfiles";
import type { StageRoute } from "../../config/stageRouting";
import type { StructuredTarget } from "./askStructured";

/**
 * GV-25 (docs/roadmap/generation-v2.md, from W2-06): the StructuredTarget a
 * Chat builder asks through, built from the stage's route (stageRouting.ts)
 * and the profile of the lane that serves it (machineProfiles.ts).
 *
 * - providerName is `local:<lane>`, the name the Chat builders report and the
 *   cost event's `provider`;
 * - model is the route's model (the lane's LiteLLM alias);
 * - structuredOutput and the per-token rates are the lane's;
 * - thinking and temperature are carried only when the route sets them, so
 *   askStructured's defaults (thinking off) hold otherwise.
 *
 * Throws for a route that is not `local`, has no lane, or names a lane other
 * than the profile's: a Chat builder serves a local lane and nothing else.
 * The messages name the provider and lane ids only (both enums), never a URL
 * or a key.
 */
export function targetFor(route: StageRoute, profile: LaneProfile): StructuredTarget {
  if (route.provider !== "local") {
    throw new Error(`targetFor: a Chat builder serves a 'local' route only, not '${route.provider}'`);
  }
  if (route.lane === undefined) throw new Error("targetFor: the local route names no lane");
  if (route.lane !== profile.id) {
    throw new Error(`targetFor: the route's lane '${route.lane}' is not the profile's lane '${profile.id}'`);
  }
  return {
    providerName: `local:${route.lane}`,
    model: route.model,
    structuredOutput: profile.structuredOutput,
    usdPerMtokIn: profile.usdPerMtokIn,
    usdPerMtokOut: profile.usdPerMtokOut,
    ...(route.thinking !== undefined ? { thinking: route.thinking } : {}),
    ...(route.temperature !== undefined ? { temperature: route.temperature } : {})
  };
}
