import type { Ladder, LadderRung } from "../types/ladders";

/**
 * Observed-not-declared entry-rung inference (CLAUDE.md principle #2 — "state
 * observed, never declared"). Reference implementation for
 * docs/curation/ladders-client-spec.md §"Entry-rung inference": the future
 * client-integration pass should port this logic (or, if the client ever
 * gains a shared-bundle build step, import it directly) rather than
 * reinventing it — this is the one place the rules are written down.
 *
 * Deliberately has NO dependency on cp_history's storage format, network
 * calls, or DOM — it takes plain arrays/objects so it's usable from the
 * client (today: a straight port), a future backend endpoint, or a test.
 */

export interface LadderProgress {
  ladderId: string;
  /** Rung ids the listener has touched at least one episode_id of. */
  reachedRungIds: string[];
  /**
   * The recommended next rung: the earliest (topological order) unreached
   * rung whose prerequisites are already satisfied. `null` means either the
   * whole ladder is reached, or the listener hasn't touched it at all (in
   * which case the caller should offer the ladder's true root rung(s) —
   * see rootRungIds below, which is always populated).
   */
  entryRungId: string | null;
  /** Rungs with no prerequisites — where a listener who has never touched
   * this ladder should start. Populated even when entryRungId is null. */
  rootRungIds: string[];
}

/**
 * Rung "reached" = the listener has an observed pick on ANY ONE episode in
 * that rung (not all of them) — a rung is a curriculum step, not a checklist;
 * see docs/curation/personalization-and-depth-plan.md §6 and the Step-D plan
 * decision "rung completion = any-one-of, correct for a curriculum."
 *
 * `prerequisites` are advisory ordering metadata (never access control — see
 * LadderRung.prerequisites in types/ladders.ts), so "satisfied" here means
 * "at least one prerequisite rung reached," not "all of them." This mirrors
 * the branching structure: fundamentals unlocks 4 parallel deep-dive
 * branches; a listener who's done any one of them has meaningfully engaged
 * with the ladder and frontier becomes a sensible next suggestion.
 *
 * Emergent property worth calling out (see ladderProgress.test.ts "prefers an
 * unexplored parallel branch over a multi-parent convergence rung"):
 * because entry-rung selection walks rungs in topological order and returns
 * the FIRST unreached+satisfied one, an untouched parallel branch is always
 * recommended before a convergence rung (like frontier) whose prerequisites
 * happen to already be satisfied by a different branch. That's intentional,
 * not a bug — it nudges toward breadth across the curriculum before
 * narrowing, which is on-brand (CLAUDE.md #1, curiosity-first /
 * anti-echo-chamber), not just a side effect of the sort order.
 *
 * `pickedEpisodeIds` today should be the listener's picked/history episode
 * ids (client-side: localStorage `cp_history`). That's a "picked," not a
 * "finished >=85%" signal — event capture (Step C) isn't built yet. See the
 * client spec for the planned upgrade once it lands; the inference algorithm
 * itself won't need to change, only its input.
 */
export function inferLadderProgress(ladder: Ladder, pickedEpisodeIds: readonly string[]): LadderProgress {
  const picked = new Set(pickedEpisodeIds);
  const reached = new Set<string>();
  for (const rung of ladder.rungs) {
    if (rung.episode_ids.some((id) => picked.has(id))) reached.add(rung.id);
  }

  const order = topologicalOrder(ladder.rungs);
  const rootRungIds = ladder.rungs.filter((r) => r.prerequisites.length === 0).map((r) => r.id);

  let entryRungId: string | null = null;
  for (const rungId of order) {
    if (reached.has(rungId)) continue;
    const rung = ladder.rungs.find((r) => r.id === rungId)!;
    const prereqsSatisfied = rung.prerequisites.length === 0 || rung.prerequisites.some((p) => reached.has(p));
    if (prereqsSatisfied) {
      entryRungId = rungId;
      break;
    }
  }

  return { ladderId: ladder.id, reachedRungIds: [...reached], entryRungId, rootRungIds };
}

/**
 * Kahn's-algorithm topological sort over the rung DAG, stable-tiebroken by
 * the rungs' original array order. Defensive against malformed input
 * (dangling prerequisite ids, cycles) — it must never throw or infinite-loop,
 * since the CI integrity check (backend/test/ladderIntegrity.test.ts) is what
 * actually enforces acyclicity/well-formedness; this function just has to
 * degrade gracefully (append anything it couldn't order, in original order)
 * if it's ever called against data that check hasn't run against yet.
 */
function topologicalOrder(rungs: readonly LadderRung[]): string[] {
  const ids = rungs.map((r) => r.id);
  const indexOf = new Map(ids.map((id, i) => [id, i]));
  const inDegree = new Map(ids.map((id) => [id, 0]));
  const dependents = new Map<string, string[]>(ids.map((id) => [id, []]));

  for (const rung of rungs) {
    for (const prereq of rung.prerequisites) {
      if (!indexOf.has(prereq)) continue; // dangling prereq — ignore defensively
      inDegree.set(rung.id, (inDegree.get(rung.id) ?? 0) + 1);
      dependents.get(prereq)!.push(rung.id);
    }
  }

  const seen = new Set<string>();
  const order: string[] = [];
  const queue = ids.filter((id) => (inDegree.get(id) ?? 0) === 0);

  while (queue.length > 0) {
    queue.sort((a, b) => indexOf.get(a)! - indexOf.get(b)!);
    const id = queue.shift()!;
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const dep of dependents.get(id) ?? []) {
      const remaining = (inDegree.get(dep) ?? 0) - 1;
      inDegree.set(dep, remaining);
      if (remaining === 0) queue.push(dep);
    }
  }

  for (const id of ids) if (!seen.has(id)) order.push(id); // cycle fallback

  return order;
}
