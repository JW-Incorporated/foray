import fs from "node:fs";
import path from "node:path";
import { servableView, type PartialCandidate } from "./partialCandidate";
import { isJobForayId, jobSnapshotFilename, JobSnapshotSchema, type JobSnapshot } from "./jobSink";

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
 * the requesting listener, exactly as a real route's auth check would.
 *
 * CORRECTED (GV-44, docs/roadmap/generation-v2.md): this header used to say
 * `readPartialCandidate` "never lists or globs the directory (only ever reads
 * the ONE file a caller names by Foray id)". That was never true: the partial
 * file is named by the prompt's slug and hash (`partialCandidateFilename`),
 * which a caller holding only the Foray id cannot rebuild, so the function
 * `readdir`s the directory and parses EVERY `*.partial.json` in it to find
 * the one whose `id` matches. The author check still holds — another
 * listener's candidate is never returned — but the read touches every
 * listener's file. The function is kept, with that behaviour unchanged, for
 * its existing callers. New callers use `readJobSnapshot` below: it reads
 * exactly one file, `<forayId>.job.json`, named by the id itself, and refuses
 * any id that could name another path.
 */

export type GenerationStatusOutcome =
  | { found: false }
  | { found: true; authorized: false }
  | { found: true; authorized: true; candidate: PartialCandidate };

/**
 * Reads the partial candidate `generateForays.ts` last wrote for `forayId`
 * (see `partialCandidateFilename`), scoped to `requestingUserId`. It scans
 * every `*.partial.json` in `candidateDir` to find the id (see the header);
 * new callers use `readJobSnapshot`, which reads one file by id.
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
  return { found: true, authorized: true, candidate: servableCandidate(candidate) };
}

/**
 * GV-21 (docs/roadmap/generation-v2.md decision 13 and 32): a stored partial
 * that carries `delivery.servableThrough` is served ONLY as its servable
 * prefix — `servableView`, an item count, prelude included — and its
 * readiness rows are cut at the same count, so nothing past the first
 * unservable act (the hand-off line, an unverified page) leaves this read
 * path, not even as an id. A malformed count serves nothing. A candidate
 * without `delivery` predates GV-21 and is returned whole, exactly as before.
 * No env is read: there is no flag.
 */
function servableCandidate(candidate: PartialCandidate): PartialCandidate {
  const delivery = candidate.delivery;
  if (!delivery) return candidate;
  const items = servableView(candidate);
  return {
    ...candidate,
    items,
    delivery: { ...delivery, items: (delivery.items ?? []).slice(0, items.length) }
  };
}

export type JobSnapshotOutcome =
  | { found: false; refused?: "invalid-id" }
  | { found: true; authorized: false }
  | { found: true; authorized: true; snapshot: JobSnapshot };

/**
 * GV-44 (W6-03): the job-row read a future `GET /generation/:id` handler
 * calls. Reads EXACTLY `<jobDir>/<forayId>.job.json` — never lists the
 * directory — and:
 * - refuses an id that fails `JOB_FORAY_ID_PATTERN` before building any path
 *   (`../x`, a slash, a dot, an empty or over-long id): `{ found: false,
 *   refused: "invalid-id" }`;
 * - treats a missing file, unparseable JSON, a document that fails
 *   `JobSnapshotSchema`, or one naming another Foray id as not found — an
 *   unvalidated document is never served;
 * - refuses a snapshot whose `authorId` is not the requesting listener.
 * A route should answer the refusal and the author mismatch the same way as
 * not-found (a 403 confirms the id exists). The snapshot's `items` are already
 * the servable prefix only (`snapshotFrom`; the schema pins
 * `delivery.servableThrough === items.length`). No env, no flag.
 */
export function readJobSnapshot(jobDir: string, forayId: string, requestingUserId: string): JobSnapshotOutcome {
  if (!isJobForayId(forayId)) return { found: false, refused: "invalid-id" };
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(jobDir, jobSnapshotFilename(forayId)), "utf8");
  } catch {
    return { found: false };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { found: false };
  }
  const checked = JobSnapshotSchema.safeParse(parsed);
  if (!checked.success || checked.data.forayId !== forayId) return { found: false };
  const snapshot = parsed as JobSnapshot;
  if (snapshot.authorId !== requestingUserId) return { found: true, authorized: false };
  return { found: true, authorized: true, snapshot };
}
