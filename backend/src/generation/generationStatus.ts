import fs from "node:fs";
import path from "node:path";
import type { PartialCandidate } from "./partialCandidate";

/**
 * WS-D2's "generation status" read path (docs/curation/generation-fix-plan-2026-09-09.md,
 * "D2 (streaming publish)"): "the generation status endpoint serves the
 * partial candidate to the requesting listener only (`visibility: "private"`)."
 *
 * WHAT THIS IS, HONESTLY. There is no HTTP server anywhere in this repo —
 * `backend/src` has no express/fastify/router of any kind (checked directly:
 * no route, no app.listen, nothing) — and Foray generation today runs only
 * as a founder-operated CLI (`backend/src/cli/generateForays.ts`), per
 * `4a-forays-in-app-plan.md`'s own finding (2026-09-08): an app-facing
 * generation service ("Path B" in that doc) needs a tailnet host, a spend
 * decision, a review-gate exception and a CSP change — four founder
 * decisions, none made yet, and D8's own comment in `app.js`
 * ("Foray generation stays out of the UI for now") is the product decision
 * that follows from that gap being open.
 *
 * So this module is the STATUS READ LOGIC a future HTTP handler calls, not a
 * route itself — the same relationship `finalizeForay.ts` has to
 * `publishForay.ts`'s CLI: the validation/read logic is built and tested
 * once, so wiring an actual `GET /generation/:id/status` handler on whatever
 * service Path B eventually stands up is a one-line call into
 * `readPartialCandidate`, not new design work. See
 * `docs/curation/player-streaming-brief.md` for the payload contract this
 * hands to a player-side poller once that service exists.
 *
 * PRIVACY, ENFORCED HERE. A partial candidate is `visibility: "private"` by
 * construction (`buildPartialCandidate`) — this function is the enforcement
 * point: it refuses to return a candidate whose `authorId` does not match
 * the requesting listener, exactly as a real route's auth check would, and
 * it never lists or globs the directory (only ever reads the ONE file a
 * caller names by Foray id), so it cannot leak the existence of another
 * listener's in-flight generation.
 */

export type GenerationStatusOutcome =
  | { found: false }
  | { found: true; authorized: false }
  | { found: true; authorized: true; candidate: PartialCandidate };

/**
 * Reads the partial candidate `generateForays.ts` last wrote for `forayId`
 * (see `partialCandidateFilename`), scoped to `requestingUserId`.
 *
 * @param candidateDir the same `--out` directory `generateForays.ts` writes
 *   to (default `data-local/foray-candidates`) — passed explicitly rather
 *   than defaulted here, so this module never has an opinion about repo
 *   layout beyond "some directory holds partial files."
 * @param forayId the candidate's `id` (`FinalizeForayInput.id` /
 *   `PartialCandidate.id`) — NOT the prompt, so a caller does not need to
 *   re-derive `partialCandidateFilename`'s slug+hash scheme itself.
 * @param requestingUserId the listener asking for status — compared against
 *   `PartialCandidate.authorId`. Phase 1 (`generation-architecture.md`
 *   §1.3): this is always a founder today, but the check is real from day
 *   one so phase 2 is a permission change, not a rewrite (the same
 *   discipline `types/generation.ts`'s `author_id` field comment states for
 *   the request side).
 */
export function readPartialCandidate(candidateDir: string, forayId: string, requestingUserId: string): GenerationStatusOutcome {
  const entries = fs.readdirSync(candidateDir, { withFileTypes: true });
  const match = entries.find((entry) => {
    if (!entry.isFile() || !entry.name.endsWith(".partial.json")) return false;
    try {
      const candidate = JSON.parse(fs.readFileSync(path.join(candidateDir, entry.name), "utf8")) as PartialCandidate;
      return candidate.id === forayId;
    } catch {
      return false;
    }
  });
  if (!match) return { found: false };

  const candidate = JSON.parse(fs.readFileSync(path.join(candidateDir, match.name), "utf8")) as PartialCandidate;
  if (candidate.authorId !== requestingUserId) return { found: true, authorized: false };
  return { found: true, authorized: true, candidate };
}
