import type { Enricher } from "../enrich/Enricher";
import type { TaxonomyFile } from "../types/taxonomy";
import type { Archetype, SessionCard, SessionCategory, SessionDoc, SessionEpisodeDetail } from "../types/session";
import { SessionDocSchema } from "../types/session";
import type { NormalizedCandidate } from "./candidateExtractor";
import { DEFAULT_WEIGHTS, scoreCandidate, type RecentPick, type ScoreComponents, type ScoreWeights } from "./scoring";
import { ARCHETYPE_LABELS, ARCHETYPE_ORDER, auditMenuDiversity, pickSlots, type DiversityAuditResult } from "./archetypes";
import { groupDuplicates, type DedupCandidate } from "../identity/dedup";
import { resolveEffectiveTaxonomy, type UserInterestsProvider } from "./userInterests";

/**
 * Ties enrichment (Tier-1 classification), dedup, scoring, and archetype
 * slotting together into the session document the app downloads
 * (02_ARCHITECTURE.md "Curation engine + session builder"). This is the
 * pipeline `npm run build-session` drives end-to-end.
 */

export interface BuildSessionOptions {
  userId: string;
  sessionKey: string;
  /** Stamped into the session doc for the blind hand-vs-machine test (R1). */
  builder?: string;
  builtAt?: Date;
  commuteMinutes: number;
  playbackSpeed: number;
  taxonomy: TaxonomyFile;
  candidates: NormalizedCandidate[];
  enricher: Enricher;
  recentPicks?: RecentPick[];
  weights?: ScoreWeights;
  maxAlternates?: number;
  /**
   * Per-user interest state (personalization-and-depth-plan.md Step A+B).
   * Optional and additive: when omitted, behavior is byte-identical to
   * before this existed — opts.taxonomy.nodes (the global taxonomy) is used
   * as-is, exactly like every existing caller/test does today. When
   * supplied, the effective per-user node weights (real observed rows ->
   * persona seed -> global taxonomy fallback, see resolveEffectiveTaxonomy)
   * are substituted everywhere opts.taxonomy.nodes would otherwise be read.
   */
  userInterestsProvider?: UserInterestsProvider;
}

export interface CandidateScoreLogEntry {
  candidateId: string;
  show: string;
  archetypeHint: Archetype;
  topics: string[];
  format: string;
  depth: string;
  components: ScoreComponents;
}

export interface BuildSessionResult {
  session: SessionDoc;
  scoreLog: CandidateScoreLogEntry[];
  diversity: DiversityAuditResult;
  droppedDuplicates: { keptId: string; droppedId: string }[];
}

/* Plain duration statement only. Commute-length framing was dropped from all
   user-facing copy on 2026-07-08 (state observed, not declared — see
   docs/DECISIONS.md) and is on the banned list in copyRules.test.ts. */
function fitLine(durationMin: number, _commuteMinutes: number, playbackSpeed: number): string {
  const adjustedMin = Math.round(durationMin / playbackSpeed);
  return `${durationMin} min (≈ ${adjustedMin} at ${playbackSpeed}×).`;
}

export async function buildSession(opts: BuildSessionOptions): Promise<BuildSessionResult> {
  const builtAt = opts.builtAt ?? new Date();
  const maxAlternates = opts.maxAlternates ?? 5;
  const weights = opts.weights ?? DEFAULT_WEIGHTS;
  const recentPicks = opts.recentPicks ?? [];

  // --- per-user interest resolution (personalization-and-depth-plan.md Step
  // A+B). Omitting userInterestsProvider keeps this byte-identical to the
  // pre-personalization pipeline: effectiveTaxonomy === opts.taxonomy.
  let effectiveTaxonomy: TaxonomyFile = opts.taxonomy;
  if (opts.userInterestsProvider) {
    const provider = opts.userInterestsProvider;
    const [userRows, personaId] = await Promise.all([
      provider.getUserTaxonomyNodes(opts.userId),
      provider.getPersonaSeed(opts.userId)
    ]);
    if (userRows.length === 0 && personaId) {
      await provider.seedFromPersona(opts.userId, personaId); // (c) lazy, once, idempotent
    }
    const [resolvedRows, persona] = await Promise.all([
      provider.getUserTaxonomyNodes(opts.userId), // re-read post-seed so a first-run session already personalizes
      personaId ? provider.getPersona(personaId) : Promise.resolve(undefined)
    ]);
    effectiveTaxonomy = { ...opts.taxonomy, nodes: resolveEffectiveTaxonomy(opts.taxonomy, resolvedRows, persona) };
  }

  // --- dedup safety net (corner case 3): drop accidental duplicates across
  // the whole candidate set before scoring, so the menu can never surface
  // two members of the same dedup group.
  const dedupInputs: DedupCandidate[] = opts.candidates.map((c) => ({
    id: c.id,
    title: c.title,
    publishedAt: toIsoDateOrNull(c.releaseDate),
    durationSeconds: c.durationMin * 60
  }));
  const groups = groupDuplicates(dedupInputs);
  const droppedDuplicates: { keptId: string; droppedId: string }[] = [];
  const dropSet = new Set<string>();
  const seenRoots = new Set<string>();
  for (const [id, root] of groups.entries()) {
    if (seenRoots.has(root)) {
      dropSet.add(id);
      droppedDuplicates.push({ keptId: root, droppedId: id });
    } else {
      seenRoots.add(root);
    }
  }
  const candidates = opts.candidates.filter((c) => !dropSet.has(c.id));

  // --- Tier-1 enrichment (cheap-first cascade; every call cost-metered
  // inside the Enricher implementation).
  const enrichedByCandidateId = new Map<string, Awaited<ReturnType<Enricher["classifyTier1"]>>>();
  for (const c of candidates) {
    const result = await opts.enricher.classifyTier1(
      {
        episodeId: c.id,
        showTitle: c.show,
        title: c.title,
        descriptionText: c.summary,
        durationSeconds: c.durationMin * 60
      },
      { userId: opts.userId }
    );
    enrichedByCandidateId.set(c.id, result);
  }

  // --- scoring
  const scoreLog: CandidateScoreLogEntry[] = [];
  const scoredByArchetype: Record<Archetype, { candidate: NormalizedCandidate; totalScore: number }[]> = {
    "deep-learn": [],
    stretch: [],
    narrative: [],
    comfort: []
  };

  for (const c of candidates) {
    const enrichment = enrichedByCandidateId.get(c.id)!;
    const components = scoreCandidate(
      {
        topics: enrichment.topics,
        publishedAtIso: toIsoDateOrNull(c.releaseDate) ?? new Date(0).toISOString(),
        evergreen: enrichment.evergreen,
        depth: c.curatedDepth, // prefer the research doc's hand-curated depth over the stub's guess
        sourceConfidence: enrichment.sourceConfidence,
        show: c.show
      },
      effectiveTaxonomy.nodes,
      recentPicks,
      weights,
      builtAt
    );

    scoreLog.push({
      candidateId: c.id,
      show: c.show,
      archetypeHint: c.archetypeHint,
      topics: enrichment.topics,
      format: enrichment.format,
      depth: c.curatedDepth,
      components
    });

    scoredByArchetype[c.archetypeHint].push({ candidate: c, totalScore: components.total });
  }

  // --- archetype slotting
  const slotPicks = pickSlots(scoredByArchetype, maxAlternates);

  // --- build episode detail records for every candidate referenced anywhere
  // (cards, alternates, category groups)
  const episodes: Record<string, SessionEpisodeDetail> = {};
  const topicsByCandidateId = new Map<string, string[]>();
  for (const c of candidates) {
    const enrichment = enrichedByCandidateId.get(c.id)!;
    topicsByCandidateId.set(c.id, enrichment.topics);
    episodes[c.id] = {
      show: c.show,
      title: c.title,
      release_date: c.releaseDate,
      duration_min: c.durationMin,
      apple_collection_id: c.appleCollectionId,
      apple_track_id: c.appleTrackId,
      summary: c.summary,
      depth: c.curatedDepth,
      format: enrichment.format,
      topics: enrichment.topics,
      ...(c.reactorTypes ? { reactor_types: c.reactorTypes } : {})
    };
  }

  // --- why-lines + cards
  const cards: SessionCard[] = [];
  for (let i = 0; i < slotPicks.length; i++) {
    const slot = slotPicks[i]!;
    const gist = episodes[slot.pick.id]?.summary ?? "";
    const userContext = buildUserContext(topicsByCandidateId.get(slot.pick.id) ?? [], effectiveTaxonomy);
    const bridgeFrom = slot.archetype === "stretch" ? dominantTaxonomyNodeId(effectiveTaxonomy) : undefined;

    const whyLineInput: Parameters<Enricher["generateWhyLine"]>[0] = {
      episodeId: slot.pick.id,
      showTitle: slot.pick.show,
      title: slot.pick.title,
      gist,
      archetype: slot.archetype,
      userContext: slot.pick.bridge ? [...userContext, slot.pick.bridge] : userContext
    };
    if (bridgeFrom !== undefined) {
      whyLineInput.bridgeFrom = bridgeFrom;
    }
    const { whyLine } = await opts.enricher.generateWhyLine(whyLineInput, { userId: opts.userId, sessionId: opts.sessionKey });

    cards.push({
      slot: i + 1,
      archetype: slot.archetype,
      archetype_label: ARCHETYPE_LABELS[slot.archetype],
      episode_id: slot.pick.id,
      why_line: whyLine,
      fit_line: fitLine(slot.pick.durationMin, opts.commuteMinutes, opts.playbackSpeed),
      alternates: slot.alternates.map((a) => a.id)
    });
  }

  // --- categories: one per archetype pool that has any candidates
  const categories: SessionCategory[] = ARCHETYPE_ORDER.filter((a) => scoredByArchetype[a].length > 0).map((a) => ({
    id: a,
    label: ARCHETYPE_LABELS[a],
    description: categoryDescription(a),
    groups: [
      {
        label: "All",
        episode_ids: [...scoredByArchetype[a]].sort((x, y) => y.totalScore - x.totalScore).map((s) => s.candidate.id)
      }
    ]
  }));

  // --- diversity self-audit (03_CURATION_SPEC.md menu constraints)
  const diversity = auditMenuDiversity({
    shows: cards.map((c) => episodes[c.episode_id]!.show),
    topLevelTaxonomyBranches: cards.flatMap((c) => episodes[c.episode_id]!.topics.map(topLevelBranch)),
    durationsMin: cards.map((c) => episodes[c.episode_id]!.duration_min)
  });

  const session: SessionDoc = SessionDocSchema.parse({
    version: 1,
    session_id: opts.sessionKey,
    builder: opts.builder ?? "machine-v1",
    built_at: builtAt.toISOString(),
    commute: {
      minutes: opts.commuteMinutes,
      playback_speed: opts.playbackSpeed,
      content_minutes: Math.round(opts.commuteMinutes * opts.playbackSpeed)
    },
    cards,
    categories,
    episodes
  });

  return { session, scoreLog, diversity, droppedDuplicates };
}

function toIsoDateOrNull(dateStr: string): string | null {
  const d = new Date(dateStr);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function topLevelBranch(nodeId: string): string {
  return nodeId.split("/")[0] ?? nodeId;
}

function dominantTaxonomyNodeId(taxonomy: TaxonomyFile): string {
  const sorted = [...taxonomy.nodes].sort((a, b) => b.weight - a.weight);
  return sorted[0]?.id ?? "unknown";
}

function buildUserContext(topics: string[], taxonomy: TaxonomyFile): string[] {
  const byId = new Map(taxonomy.nodes.map((n) => [n.id, n]));
  return topics.map((t) => byId.get(t)?.label).filter((l): l is string => !!l);
}

function categoryDescription(archetype: Archetype): string {
  switch (archetype) {
    case "deep-learn":
      return "Highest-relevance picks in your strongest interest areas.";
    case "stretch":
      return "Adjacent-but-excellent picks outside your usual clusters.";
    case "narrative":
      return "Story-driven history and documentary picks.";
    case "comfort":
      return "Low-cognitive-load hangs and favorites.";
  }
}
