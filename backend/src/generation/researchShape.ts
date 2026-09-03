import type { IntentUnderstanding } from "../types/generation";
import type { ResearchShape, SubtopicCandidate, TapeAvailability, TapeSignal } from "../types/research";
import {
  conceptLabel,
  loadCatalogueData,
  matchConceptsInText,
  queryTapeAvailability,
  tokenizeForCatalogueQuery,
  type CatalogueData
} from "./catalogueLookup";
import type { ExternalResearcher, ExternalResearchContext } from "./ExternalResearcher";

/**
 * §4.2 — research to establish shape (docs/curation/generation-architecture.md
 * §4.2), taking §4.1's `IntentUnderstanding` as input.
 *
 * "Enough research to know what the acts are, not enough to write them."
 * Produces a `ResearchShape`: candidate sub-topics/angles, a tape-
 * availability signal for each, known controversies, and anything external
 * research surfaced. Feeds §4.3 (spine building) as its input.
 *
 * TWO SOURCES, DELIBERATE ORDER (§4.2 verbatim):
 *   1. The local catalogue (`catalogueLookup.ts`) — free, instant, checked
 *      for every candidate subtopic first.
 *   2. External research (`ExternalResearcher`) — invoked ONLY for a
 *      subtopic the catalogue has NO tape for (`signal === "none"`). This
 *      is the "cheap first" ordering the task's own tests hold to: a
 *      subtopic the catalogue already answers must never trigger a paid
 *      call.
 *
 * GUARDRAIL, ENFORCED STRUCTURALLY (§4.2): tape availability is a SIGNAL
 * attached to every candidate, never a filter. A subtopic the catalogue
 * has zero tape for still gets a full entry in `subtopics` — it is
 * eligible for external research and for §4.3's spine exactly like a
 * tape-rich one. Nothing in this module removes a candidate for having a
 * "none" signal.
 *
 * SCOPE (per §5's topology table: "1, may fan out for lookups"): this
 * function is the one synthesis head; `fanOutExternalResearch` below is
 * the only parallelism, and it is bounded, independent per-subtopic
 * lookups — not a multi-agent orchestration.
 */

const MAX_SUBTOPICS = 8;
/** How many of the top-matched concept's `related` concepts to pull in for
 * breadth, beyond the literal terms already in subject/angle — this is what
 * keeps the map from being just a restatement of the prompt. */
const MAX_RELATED_CONCEPTS = 3;

export function tapeSignalFor(itemCount: number): TapeSignal {
  if (itemCount === 0) return "none";
  if (itemCount < 5) return "thin";
  if (itemCount < 20) return "moderate";
  return "strong";
}

function buildTapeAvailability(terms: string[], catalogue: CatalogueData): TapeAvailability {
  const result = queryTapeAvailability(terms, catalogue);
  return {
    signal: tapeSignalFor(result.itemCount),
    itemCount: result.itemCount,
    showCount: result.showCount,
    exampleItemIds: result.exampleItemIds
  };
}

interface CandidateSeed {
  label: string;
  source: "semantic-concept" | "literal-term";
  terms: string[];
}

/**
 * Builds the candidate list from the intent's subject+angle text: every
 * matched semantic-index concept (subject/angle terms overlapping a
 * concept's `terms`), plus up to `MAX_RELATED_CONCEPTS` concepts related to
 * the top match for breadth beyond the literal ask. Falls back to the raw
 * subject phrase as a single literal-term candidate when nothing in the
 * catalogue's concept vocabulary matches at all — this is the case §4.2's
 * guardrail cares most about: a genuinely untaped subject must still
 * produce a real candidate, not an empty map.
 */
function buildCandidateSeeds(intent: IntentUnderstanding, catalogue: CatalogueData): CandidateSeed[] {
  const queryText = `${intent.subject} ${intent.angle}`;
  const matched = matchConceptsInText(queryText, catalogue.concepts);

  if (matched.length === 0) {
    return [{ label: intent.subject, source: "literal-term", terms: tokenizeSubject(intent.subject) }];
  }

  const seeds: CandidateSeed[] = [];
  const seen = new Set<string>();

  for (const key of matched.slice(0, MAX_SUBTOPICS)) {
    seeds.push({ label: conceptLabel(key), source: "semantic-concept", terms: catalogue.concepts[key]!.terms });
    seen.add(key);
  }

  // Breadth: related concepts of the top (best-matched) concept, so the map
  // surfaces adjacent angles the prompt didn't literally name — exactly the
  // "non-obvious angle" §4.2 asks the research stage to help locate.
  const topKey = matched[0]!;
  const related = catalogue.concepts[topKey]?.related ?? [];
  let relatedAdded = 0;
  for (const relKey of related) {
    if (relatedAdded >= MAX_RELATED_CONCEPTS || seeds.length >= MAX_SUBTOPICS) break;
    if (seen.has(relKey) || !catalogue.concepts[relKey]) continue;
    seeds.push({ label: conceptLabel(relKey), source: "semantic-concept", terms: catalogue.concepts[relKey]!.terms });
    seen.add(relKey);
    relatedAdded += 1;
  }

  return seeds;
}

function tokenizeSubject(subject: string): string[] {
  return tokenizeForCatalogueQuery(subject);
}

/**
 * External-research fan-out (§5: "may fan out for lookups"). Runs the
 * bounded set of catalogue-gap subtopics in parallel — never more than
 * `MAX_SUBTOPICS` calls, each an independent per-subtopic lookup with no
 * shared context between them, which is exactly the shape §5 permits at
 * this stage (as opposed to §4.4's per-act agents, which share the full
 * spine).
 */
async function fanOutExternalResearch(
  gaps: Array<{ seed: CandidateSeed; tape: TapeAvailability }>,
  researcher: ExternalResearcher,
  ctx: ExternalResearchContext
): Promise<Map<string, { notes: string; controversies: string[] }>> {
  const results = await Promise.all(
    gaps.map(async ({ seed }) => {
      const r = await researcher.research(seed.label, ctx);
      return [seed.label, r] as const;
    })
  );
  return new Map(results.map(([label, r]) => [label, { notes: r.notes, controversies: r.controversies }]));
}

export interface BuildResearchShapeOptions {
  researcher: ExternalResearcher;
  ctx: ExternalResearchContext;
  /** Injectable for tests; defaults to the real on-disk catalogue. */
  catalogue?: CatalogueData;
}

/**
 * §4.2 end to end: reads §4.1's intent, queries the local catalogue for
 * every candidate subtopic FIRST, then fans out to external research only
 * for the subtopics the catalogue could not answer (`signal === "none"`),
 * and returns the structured `ResearchShape` that §4.3 (spine building)
 * consumes as its input.
 */
export async function buildResearchShape(
  intent: IntentUnderstanding,
  options: BuildResearchShapeOptions
): Promise<ResearchShape> {
  const catalogue = options.catalogue ?? loadCatalogueData();
  const seeds = buildCandidateSeeds(intent, catalogue);

  const withTape = seeds.map((seed) => ({ seed, tape: buildTapeAvailability(seed.terms, catalogue) }));
  const gaps = withTape.filter((s) => s.tape.signal === "none");

  const externalResults =
    gaps.length > 0 ? await fanOutExternalResearch(gaps, options.researcher, options.ctx) : new Map<string, { notes: string; controversies: string[] }>();

  const subtopics: SubtopicCandidate[] = withTape.map(({ seed, tape }) => {
    const external = externalResults.get(seed.label);
    return {
      label: seed.label,
      source: seed.source,
      tape,
      controversies: external?.controversies ?? [],
      externalNotes: external?.notes ?? null,
      externallyResearched: external !== undefined
    };
  });

  return {
    subject: intent.subject,
    angle: intent.angle,
    generatedAt: new Date().toISOString(),
    subtopics,
    nonObviousAngle: intent.angle,
    externalGapsResearched: gaps.map((g) => g.seed.label)
  };
}
