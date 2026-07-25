import type { Ladder, LadderLevel, LadderRung } from "../types/ladders";

/**
 * Token-light, deterministic ladder assembly (docs/curation/personalization-and-
 * depth-plan.md §6 + the Step-D implementation plan). This module does ZERO LLM
 * calls — it orders and buckets episodes that are ALREADY tagged (topics/depth/
 * format, plus optional curator-supplied role/subtopic hints) into a
 * prerequisite-ordered curriculum. The only place prose is ever authored is
 * `goal` text, which this module never invents — it's supplied by the caller
 * (hand-written by a curator today; see backend/src/cli/buildLadder.ts) and
 * merged in afterward. See §7 of the plan: "LLM tags items offline, at query/
 * build time it does nothing but occasionally translate — never selects or
 * ranks content." This module IS the deterministic selection/ranking step.
 */

export interface EnrichedEpisode {
  id: string;
  durationMin: number;
  depth: "low" | "medium" | "high";
  format: string;
  releaseDate: string; // ISO or YYYY-MM-DD
  /**
   * Curator override: force this episode into a specific ladder role instead
   * of letting the heuristic pick. Optional — most episodes have none and
   * fall into the deep-dive pool, bucketed by `subtopicKey`.
   */
  roleHint?: "overview" | "fundamentals" | "frontier";
  /** Curator-supplied deep-dive branch grouping key (id-safe, e.g. "tokamak"). */
  subtopicKey?: string;
  /** Human display label for the branch (e.g. "Tokamak"). Falls back to subtopicKey. */
  subtopicLabel?: string;
}

export interface BuildLadderSkeletonOptions {
  ladderId: string;
  node: string;
  title: string;
  episodes: EnrichedEpisode[];
  /**
   * Rung goal text, keyed by the rung id the skeleton will produce
   * ("overview", "fundamentals", "deep-dive-<subtopicKey>", "frontier").
   * The builder never invents this prose (see module docstring) — every rung
   * id present in the output MUST have an entry here or buildLadderSkeleton
   * throws, forcing an explicit human-authored line rather than silently
   * shipping empty/generic copy.
   */
  goals: Record<string, string>;
  /**
   * Fraction of the non-overview/fundamentals pool to treat as "frontier"
   * (most recent by release date) when no episode carries an explicit
   * roleHint: "frontier". Default 0.15, capped at 2 episodes either way —
   * matches the flagship Fusion ladder's shape without hardcoding "2".
   */
  frontierFraction?: number;
  frontierCapCount?: number;
}

const DEFAULT_FRONTIER_FRACTION = 0.15;
const DEFAULT_FRONTIER_CAP = 2;

/**
 * Builds one ladder's rung skeleton deterministically from an already-tagged
 * episode pool. Pure function — no I/O, no LLM, fully unit-testable.
 *
 * Algorithm (see docs/curation/personalization-and-depth-plan.md §6 and the
 * Step-D plan for rationale):
 *   1. overview  = roleHint:"overview" episode, else shortest non-high-depth
 *                  episode (else shortest overall if the pool is all "high").
 *   2. fundamentals = roleHint:"fundamentals" episode, else shortest
 *                  remaining non-high-depth episode (else shortest remaining).
 *   3. frontier  = roleHint:"frontier" episodes, else the N most-recent
 *                  (by release date) remaining episodes, N from
 *                  frontierFraction/frontierCapCount.
 *   4. everything left = the deep-dive pool, bucketed by subtopicKey into
 *                  parallel branch rungs (or one undifferentiated rung if no
 *                  episode carries a subtopicKey).
 *   5. prerequisites: overview -> fundamentals -> each deep-dive branch
 *      (parallel) -> frontier (converges on every deep-dive branch that
 *      exists; falls back to fundamentals if there are no deep-dive
 *      branches). Advisory ordering only — see LadderRung.prerequisites doc.
 */
export function buildLadderSkeleton(options: BuildLadderSkeletonOptions): Ladder {
  const { ladderId, node, title, episodes, goals } = options;
  const frontierFraction = options.frontierFraction ?? DEFAULT_FRONTIER_FRACTION;
  const frontierCap = options.frontierCapCount ?? DEFAULT_FRONTIER_CAP;

  if (episodes.length === 0) {
    throw new Error(`buildLadderSkeleton: no episodes supplied for ladder "${ladderId}"`);
  }

  const remaining = new Map(episodes.map((e) => [e.id, e]));
  const take = (id: string): EnrichedEpisode => {
    const ep = remaining.get(id);
    if (!ep) throw new Error(`buildLadderSkeleton: episode "${id}" already assigned or missing`);
    remaining.delete(id);
    return ep;
  };

  // Guaranteed non-undefined: `remaining` has >=1 episode (checked above) the
  // first time pickShortestPreferringNonHigh is ever called.
  const overview = pickByRole(remaining, "overview") ?? pickShortestPreferringNonHigh(remaining)!;
  take(overview.id);

  const fundamentals = pickByRole(remaining, "fundamentals") ?? pickShortestPreferringNonHigh(remaining);
  if (fundamentals) take(fundamentals.id);

  const frontierPicks = pickFrontier(remaining, frontierFraction, frontierCap);
  for (const ep of frontierPicks) take(ep.id);

  // Everything left is the deep-dive pool, bucketed by subtopicKey.
  const deepDivePool = [...remaining.values()];
  const branches = bucketBySubtopic(deepDivePool);

  const rungs: LadderRung[] = [];
  rungs.push(makeRung("overview", "overview", null, [overview.id], [], goals));

  const fundamentalsId = "fundamentals";
  if (fundamentals) {
    rungs.push(makeRung(fundamentalsId, "fundamentals", null, [fundamentals.id], ["overview"], goals));
  }
  const fundamentalsPrereq = fundamentals ? [fundamentalsId] : [];

  const branchIds: string[] = [];
  for (const branch of branches) {
    const rungId = `deep-dive-${branch.key}`;
    branchIds.push(rungId);
    const orderedBranchEpisodes = [...branch.episodes].sort(sortByDurationThenId(branch.episodes));
    rungs.push(
      makeRung(
        rungId,
        "deep-dive",
        branch.label,
        orderedBranchEpisodes.map((e) => e.id),
        fundamentalsPrereq,
        goals
      )
    );
  }

  if (frontierPicks.length > 0) {
    const frontierPrereqs = branchIds.length > 0 ? branchIds : fundamentalsPrereq;
    rungs.push(
      makeRung(
        "frontier",
        "frontier",
        null,
        frontierPicks.map((e) => e.id),
        frontierPrereqs,
        goals
      )
    );
  }

  const estimatedTotalMin = episodes.reduce((sum, e) => sum + e.durationMin, 0);

  return {
    id: ladderId,
    node,
    title,
    status: "draft",
    estimated_total_min: estimatedTotalMin,
    rungs
  };
}

function makeRung(
  id: string,
  level: LadderLevel,
  subtopic: string | null,
  episodeIds: string[],
  prerequisites: string[],
  goals: Record<string, string>
): LadderRung {
  const goal = goals[id];
  if (!goal) {
    throw new Error(
      `buildLadderSkeleton: rung "${id}" has no goal text in the supplied goals map — ` +
        `this builder never invents rung prose (see module docstring); supply goals["${id}"].`
    );
  }
  return { id, level, subtopic, goal, episode_ids: episodeIds, prerequisites };
}

function pickByRole(
  pool: Map<string, EnrichedEpisode>,
  role: "overview" | "fundamentals" | "frontier"
): EnrichedEpisode | undefined {
  for (const ep of pool.values()) {
    if (ep.roleHint === role) return ep;
  }
  return undefined;
}

/** Shortest non-high-depth episode; falls back to the shortest episode overall
 * if every remaining episode is depth:"high" (e.g. a small, all-technical pool).
 * Returns undefined only if the pool is empty (e.g. a 1-episode ladder that
 * used its only episode as the overview, leaving nothing for fundamentals). */
function pickShortestPreferringNonHigh(pool: Map<string, EnrichedEpisode>): EnrichedEpisode | undefined {
  const all = [...pool.values()];
  if (all.length === 0) return undefined;
  const nonHigh = all.filter((e) => e.depth !== "high");
  const candidates = nonHigh.length > 0 ? nonHigh : all;
  return [...candidates].sort(sortByDurationThenId(candidates))[0];
}

function pickFrontier(
  pool: Map<string, EnrichedEpisode>,
  frontierFraction: number,
  frontierCap: number
): EnrichedEpisode[] {
  const hinted = [...pool.values()].filter((e) => e.roleHint === "frontier");
  if (hinted.length > 0) return hinted.sort(sortByDurationThenId(hinted));

  const all = [...pool.values()];
  const n = Math.min(frontierCap, Math.round(all.length * frontierFraction));
  if (n <= 0) return [];
  return [...all]
    .sort((a, b) => (b.releaseDate < a.releaseDate ? -1 : b.releaseDate > a.releaseDate ? 1 : a.id.localeCompare(b.id)))
    .slice(0, n)
    .sort(sortByDurationThenId(all));
}

interface SubtopicBranch {
  key: string;
  label: string | null;
  episodes: EnrichedEpisode[];
}

/** Groups the deep-dive pool by subtopicKey, in alphabetical key order for
 * determinism. Episodes with no subtopicKey all fall into one "general"
 * branch (rendered as a single undifferentiated deep-dive rung, subtopic:null
 * rather than a synthetic "General" label — cleaner for the common
 * "no manual branching supplied" case). */
function bucketBySubtopic(pool: EnrichedEpisode[]): SubtopicBranch[] {
  const byKey = new Map<string, SubtopicBranch>();
  for (const ep of pool) {
    const key = ep.subtopicKey ?? "general";
    const label = ep.subtopicKey ? (ep.subtopicLabel ?? capitalize(ep.subtopicKey)) : null;
    const existing = byKey.get(key);
    if (existing) {
      existing.episodes.push(ep);
    } else {
      byKey.set(key, { key, label, episodes: [ep] });
    }
  }
  return [...byKey.values()].sort((a, b) => a.key.localeCompare(b.key));
}

function sortByDurationThenId(_context: EnrichedEpisode[]) {
  return (a: EnrichedEpisode, b: EnrichedEpisode) => a.durationMin - b.durationMin || a.id.localeCompare(b.id);
}

function capitalize(s: string): string {
  return s.length === 0 ? s : s[0]!.toUpperCase() + s.slice(1);
}
