import type { Archetype } from "../types/session";

/**
 * The 4-slot menu: variety by construction (03_CURATION_SPEC.md). Each
 * slot draws from its own candidate pool rather than taking top-4 of one
 * ranked list — the archetype grouping happens upstream (candidate
 * extraction tags each candidate with an archetypeHint); this module just
 * picks winner + alternates per pool and audits cross-menu diversity.
 */

/* "deep-learn" was labelled "Deep dive" until 2026-09-23 (qa 152): a phrase
   CLAUDE.md copy rule 4 bans, in a field the iOS card renders as a header.
   copyRules.test.ts now reads every string on a card, so the label is gated. */
export const ARCHETYPE_LABELS: Record<Archetype, string> = {
  "deep-learn": "Go deep",
  stretch: "Stretch",
  narrative: "Story",
  comfort: "Comfort"
};

export const ARCHETYPE_ORDER: Archetype[] = ["deep-learn", "stretch", "narrative", "comfort"];

export interface SlotCandidate<C> {
  candidate: C;
  totalScore: number;
}

export interface SlotPick<C> {
  archetype: Archetype;
  pick: C;
  alternates: C[];
}

/**
 * Picks the top-scored candidate per archetype pool plus up to `maxAlternates`
 * runners-up. The Stretch slot's epsilon-greedy floor (03_CURATION_SPEC.md:
 * "this slot ignores my historical skip rate for the region it explores")
 * is implicit here: Stretch candidates are drawn from a pool the caller has
 * already restricted to adjacent/cold-taxonomy material, so ranking within
 * that pool by score is fine — the exploration guarantee comes from the
 * pool selection (candidateExtractor tagging), not from ignoring score here.
 */
export function pickSlots<C>(
  pools: Record<Archetype, SlotCandidate<C>[]>,
  maxAlternates = 5
): SlotPick<C>[] {
  const picks: SlotPick<C>[] = [];
  for (const archetype of ARCHETYPE_ORDER) {
    const pool = [...(pools[archetype] ?? [])].sort((a, b) => b.totalScore - a.totalScore);
    if (pool.length === 0) continue;
    const [top, ...rest] = pool;
    picks.push({
      archetype,
      pick: top!.candidate,
      alternates: rest.slice(0, maxAlternates).map((c) => c.candidate)
    });
  }
  return picks;
}

export interface DiversityAuditInput {
  shows: string[];
  topLevelTaxonomyBranches: string[];
  durationsMin: number[];
}

export interface DiversityAuditResult {
  distinctShows: number;
  distinctBranches: number;
  itemsOver90Min: number;
  warnings: string[];
}

/**
 * Menu diversity self-audit (03_CURATION_SPEC.md constraints: >=3 distinct
 * shows, >=3 distinct top-level taxonomy branches, <=1 item over 90 min;
 * corner case 25's weekly diversity self-audit uses the same shape at a
 * longer time horizon — this is the per-session version).
 */
export function auditMenuDiversity(input: DiversityAuditInput): DiversityAuditResult {
  const distinctShows = new Set(input.shows).size;
  const distinctBranches = new Set(input.topLevelTaxonomyBranches).size;
  const itemsOver90Min = input.durationsMin.filter((d) => d > 90).length;

  const warnings: string[] = [];
  if (distinctShows < 3) warnings.push(`only ${distinctShows} distinct shows in menu (want >=3)`);
  if (distinctBranches < 3) warnings.push(`only ${distinctBranches} distinct taxonomy branches in menu (want >=3)`);
  if (itemsOver90Min > 1) warnings.push(`${itemsOver90Min} items over 90 minutes (want <=1)`);

  return { distinctShows, distinctBranches, itemsOver90Min, warnings };
}
