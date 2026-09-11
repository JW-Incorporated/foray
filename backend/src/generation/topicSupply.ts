import { loadTaxonomyNodes, type ResolveTopicResult, type TopicCandidate } from "./resolveTopic";
import { tokenizeForCatalogueQuery } from "./catalogueLookup";
import { familyGateAllows, nodesForArchiveEntry, nodesForPoolSegment, type PoolSegmentLike } from "./taxonomyFamily";
import type { TranscriptDigestEntry } from "./transcriptArchiveLookup";

/**
 * F-91 — SUPPLY-AWARE TOPIC RESOLUTION (docs/curation/generation-run-2026-09-09.md).
 *
 * WHAT RUN 8 DID. The prompt "What engineers actually do all day: how
 * engineering careers really work…" resolved to `business/careers` — one
 * distinctive token, "careers", scoring 1.5 against 0.75 for every engineering
 * child — and §4.5's lineage gate then did exactly what it is for: it refused
 * every episode of *Being an Engineer* (334 indexed, the only show in the
 * archive that is about this subject) because that show carries `engineering`
 * nodes and `business/careers`'s family contains none of them. All 29 beats
 * reported `tier2:text-index:no-candidate`, the run stopped NO TAPE, and the
 * Opus spine call plus four Sonnet deepen calls were spent on a subject the
 * archive was never going to be allowed to carry. "The history of India…" fails
 * the same way through `cities/urbanism` (token: "cities"). This is the
 * "topic-lineage" collapse G-24 named.
 *
 * THE GATE IS RIGHT; THE TOPIC FEEDING IT WAS A LOTTERY. `resolveTopic` scores
 * words against 194 node labels and knows nothing about tape. Between two
 * candidates a word-scorer cannot separate — a 1.5 and a 0.75 on a
 * 30-word prompt is not a judgement, it is one token — the thing that should
 * decide is whether the archive HAS anything in the candidate's family. That
 * is a count, it is deterministic, and it costs one pass over the digest
 * archive per candidate. So this module measures it and lets it break the tie,
 * within two bounds:
 *
 *   - `MIN_TOPIC_SUPPLY`: a candidate needs at least this many usable
 *     transcripts before supply counts as a reason. One stray episode is not
 *     supply; it is the coincidence F-38 was about.
 *   - `TOPIC_SUPPLY_SCORE_FLOOR`: only candidates scoring at least this
 *     fraction of the best score are considered at all. Supply is a
 *     tie-breaker between readings the resolver could not separate, never a
 *     licence to pick a well-stocked node the prompt barely mentions.
 *
 * If the best-scoring candidate has supply, it stays — nothing here second-
 * guesses a resolution the archive can carry. If NO considered candidate has
 * supply, the run should stop BEFORE the spine, saying so: that is a subject
 * the archive cannot carry, and the fix is supply, not another model call.
 *
 * THE ROOT STAND-IN. Every engineering child on run 8's shortlist scored on
 * the same single word, "engineering" — a GENERIC token in `resolveTopic`'s
 * own terms, one that "says which corner of the taxonomy is being talked
 * about and nothing more". The corner is THE ROOT THAT WORD NAMES: a
 * candidate whose whole case is generic words is evidence for the root whose
 * own name is that word (`engineering`), and that root is added to the
 * considered set at the candidate's score (the child bonus was a preference
 * for specificity, and specificity the prompt did not ask for is what put the
 * prompt on `energy-fusion` in F-59). The root's family is every child, so it
 * is what reaches a show the catalogue classified under a SIBLING of the
 * child that happened to sort first — *Being an Engineer* is
 * `engineering/precision-mfg` on main, and no `ai-robotics` pick would have
 * admitted it.
 *
 * TWO THINGS THE STAND-IN IS NOT. It is not the generic child's OWN root:
 * "The history of India" lists `food/food-history` on the word "history", and
 * that word names `history`, not `food` — a cider-and-barbecue archive has 87
 * entries in `food`'s family and not one of them is about India. And a
 * generic-only candidate is never picked ITSELF, for the same reason: its
 * score is a corner, not a subject, and `food/food-history`'s 14 pool
 * segments would otherwise carry that prompt. Such candidates stay in the
 * record, marked ineligible; a generic word that names no root (`systems`,
 * `modern`) adds nothing.
 *
 * WHAT "USABLE" COUNTS. Both of §4.5's tiers, through the SAME predicates the
 * tiers apply — `familyGateAllows` over `nodesForArchiveEntry` for a digest
 * entry and over `nodesForPoolSegment` for a curated pool segment — imported,
 * not copied, so the count and the gates cannot disagree. A pool segment is
 * tape whether or not a body is on disk (it was cut and anchored by a
 * curator); an archive entry is optionally narrowed by `isSearchable` to those
 * with a transcript body on this machine, because a digest row nothing can
 * open is not tape tier 2 can use: on main's data `business/careers` admits
 * 990 breadth entries of a healthcare-news show (classified at its `business`
 * root) that the text index has never seen.
 */

/** Usable transcripts a candidate topic needs before supply counts as a reason. */
export const MIN_TOPIC_SUPPLY = 3;

/**
 * Candidates scoring below this fraction of the best score are not
 * considered, however much tape they have. Half: run 8's shortlist was 1.5
 * against 0.75s, and that is the width of "one token apart".
 */
export const TOPIC_SUPPLY_SCORE_FLOOR = 0.5;

export interface TopicSupply {
  id: string;
  /** `archive + pool` — the number the decision is made on. */
  usable: number;
  /** Archive entries the topic's family admits (and `isSearchable` accepts). */
  archive: number;
  /** Curated pool segments the topic's family admits (tier 1's supply). */
  pool: number;
  /** Archive entries per `show_id` — what a person reads to see WHICH show carries the topic. */
  byShow: Record<string, number>;
}

export type TopicSupplyMap = Map<string, TopicSupply>;

export interface MeasureTopicSupplyOptions {
  archive: readonly TranscriptDigestEntry[];
  /** `data/segments.json`'s rows — tier 1's supply. Omitted, only the archive counts. */
  segmentPool?: readonly PoolSegmentLike[];
  /** Repo root for the catalogue reads the gate makes. Tests only. */
  root?: string;
  /**
   * Narrows the count to entries tier 2 could actually open — a body on this
   * machine. Omitted, every family-admitted archive entry counts, which is the
   * honest measure on a checkout with no bodies at all (CI).
   */
  isSearchable?: (entry: TranscriptDigestEntry) => boolean;
}

/** A considered topic, as the decision reports it. */
export interface ConsideredTopic {
  id: string;
  /** The resolver's score; `null` for a topic the caller pinned (never scored). */
  score: number | null;
  supply: number;
  /** Whether supply may move the choice HERE. False for a candidate whose
   * whole case is generic words — it is evidence for a root, not a subject. */
  eligible: boolean;
  /** Set when this root was added on behalf of a generic-only candidate. */
  standInFor?: string;
}

/** `pinned` is never returned by `chooseTopic`: it is the record a caller
 * builds (`pinnedTopicDecision`) when a human supplied the node. */
export type TopicChoiceReason = "best" | "supply-aware" | "no-supply" | "unresolved" | "pinned";

export interface TopicDecision {
  /** The chosen node; `null` only when the resolver itself resolved nothing. */
  topic: string | null;
  /** The resolver's own pick, before supply had a say — what `supply-aware` moved FROM. */
  resolved: string | null;
  reason: TopicChoiceReason;
  /** Every candidate weighed, best first, with its supply — the ledger's evidence. */
  considered: ConsideredTopic[];
  /** `MIN_TOPIC_SUPPLY` as applied, so a report is legible without the source. */
  minSupply: number;
}

/** The decision record for a topic the caller pinned: not scored, not
 * second-guessed, its supply measured and carried so a report can say what
 * the archive had for it. */
export function pinnedTopicDecision(topic: string, supply: TopicSupplyMap, minSupply: number = MIN_TOPIC_SUPPLY): TopicDecision {
  return {
    topic,
    resolved: null,
    reason: "pinned",
    considered: [{ id: topic, score: null, supply: supply.get(topic)?.usable ?? 0, eligible: true }],
    minSupply
  };
}

export interface ChooseTopicOptions {
  minSupply?: number;
  scoreFloor?: number;
  /** Repo root for the taxonomy read the root stand-in needs. Tests only. */
  root?: string;
}

/* ------------------------------------------------------------------------- */
/* Which topics to measure                                                    */
/* ------------------------------------------------------------------------- */

interface Weighed {
  id: string;
  score: number;
  eligible: boolean;
  standInFor?: string;
}

/** A candidate whose whole case is generic words — see the header's root stand-in. */
function isGenericOnly(candidate: TopicCandidate): boolean {
  return candidate.distinctiveTokens.length === 0 && candidate.matchedTerms.length === 0;
}

/**
 * token -> the ROOT node that token names. Only single-word roots
 * (`engineering`, `history`, `food`): a hyphenated root (`true-crime`,
 * `tv-film`) is two words neither of which names it on its own.
 */
function rootsByToken(root: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of loadTaxonomyNodes(root)) {
    if (node.parent) continue;
    const tokens = tokenizeForCatalogueQuery(node.id.split("-").join(" "));
    if (tokens.length === 1) out.set(tokens[0]!, node.id);
  }
  return out;
}

/**
 * The resolver's shortlist plus the root stand-ins, scored, best first. Ties
 * keep the resolver's own order (score, then id), so the list is stable.
 */
function weighCandidates(candidates: readonly TopicCandidate[], root: string | undefined): Weighed[] {
  const byId = new Map<string, Weighed>();
  for (const c of candidates) byId.set(c.id, { id: c.id, score: c.score, eligible: !isGenericOnly(c) });
  const roots = rootsByToken(root);
  for (const c of candidates) {
    if (!isGenericOnly(c)) continue;
    for (const token of c.matchedTokens) {
      const named = roots.get(token);
      if (!named) continue;
      const existing = byId.get(named);
      if (!existing) {
        byId.set(named, { id: named, score: c.score, eligible: true, ...(named !== c.id ? { standInFor: c.id } : {}) });
        continue;
      }
      /* The root is already listed (on its own generic word, or lent by an
         earlier child) — it becomes eligible, and takes the higher score. */
      existing.eligible = true;
      if (c.score > existing.score) {
        existing.score = c.score;
        if (named !== c.id) existing.standInFor = c.id;
      }
    }
  }
  return [...byId.values()].sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
}

/**
 * Every node id `chooseTopic` will weigh for a resolution — the shortlist, the
 * resolved node, and the root stand-ins — so a caller measures exactly the set
 * the decision needs, once.
 */
export function consideredTopicIds(resolved: ResolveTopicResult, options: { root?: string } = {}): string[] {
  const ids = weighCandidates(resolved.candidates, options.root).map((w) => w.id);
  if (resolved.resolved && !ids.includes(resolved.resolved)) ids.unshift(resolved.resolved);
  return ids;
}

/* ------------------------------------------------------------------------- */
/* Measuring                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * How much tape each candidate topic's family admits — archive entries through
 * the exact predicate §4.5's tier 2 applies (`familyGateAllows` over
 * `nodesForArchiveEntry`) and pool segments through tier 1's
 * (`nodesForPoolSegment`). One pass over each per candidate, an entry's nodes
 * resolved once and shared across candidates.
 */
export function measureTopicSupply(
  candidates: ReadonlyArray<TopicCandidate | string>,
  options: MeasureTopicSupplyOptions
): TopicSupplyMap {
  const ids = [...new Set(candidates.map((c) => (typeof c === "string" ? c : c.id)))];
  const out: TopicSupplyMap = new Map();
  if (ids.length === 0) return out;

  /* Memoised per entry: the catalogue joins are the expensive half, and they
     do not depend on which candidate is asking. */
  const entries = options.archive
    .filter((entry) => (options.isSearchable ? options.isSearchable(entry) : true))
    .map((entry) => ({ entry, nodes: nodesForArchiveEntry(entry, options.root) }));
  const segments = (options.segmentPool ?? []).map((segment) => nodesForPoolSegment(segment, options.root));

  for (const id of ids) {
    const byShow: Record<string, number> = {};
    let archive = 0;
    for (const { entry, nodes } of entries) {
      if (!familyGateAllows(id, nodes, options.root)) continue;
      archive += 1;
      byShow[entry.show_id] = (byShow[entry.show_id] ?? 0) + 1;
    }
    let pool = 0;
    for (const nodes of segments) if (familyGateAllows(id, nodes, options.root)) pool += 1;
    out.set(id, { id, usable: archive + pool, archive, pool, byShow });
  }
  return out;
}

/* ------------------------------------------------------------------------- */
/* Choosing                                                                   */
/* ------------------------------------------------------------------------- */

/**
 * The topic a run should proceed with, given the resolver's verdict and the
 * archive's supply.
 *
 *   - `best`: the resolved node has supply — it stays, untouched.
 *   - `supply-aware`: it has none, and an ELIGIBLE candidate scoring at least
 *     `scoreFloor × best` does; the highest-scoring such candidate is chosen
 *     (ties: more supply, then id). Eligible: a candidate with distinctive
 *     evidence, or a root a generic word names — see the header.
 *   - `no-supply`: nothing considered has supply. `topic` is still the
 *     resolver's pick, so a caller that ignores the reason behaves as before —
 *     but the caller SHOULD stop here, and `runPipeline` does.
 *   - `unresolved`: the resolver resolved nothing. Supply is measured for the
 *     shortlist anyway (it is what a person reads to pick by hand), but nothing
 *     here promotes a candidate that never cleared the resolver's bar —
 *     `resolveTopic`'s "fails rather than guesses" stands.
 *
 * A supply the caller did not measure counts as zero, which fails closed:
 * measure with `consideredTopicIds` to give every candidate its number.
 */
export function chooseTopic(resolved: ResolveTopicResult, supply: TopicSupplyMap, options: ChooseTopicOptions = {}): TopicDecision {
  const minSupply = options.minSupply ?? MIN_TOPIC_SUPPLY;
  const scoreFloor = options.scoreFloor ?? TOPIC_SUPPLY_SCORE_FLOOR;
  const supplyOf = (id: string): number => supply.get(id)?.usable ?? 0;

  const weighed = weighCandidates(resolved.candidates, options.root);
  const considered: ConsideredTopic[] = weighed.map((w) => ({
    id: w.id,
    score: w.score,
    supply: supplyOf(w.id),
    eligible: w.eligible,
    ...(w.standInFor ? { standInFor: w.standInFor } : {})
  }));

  const best = resolved.resolved;
  if (!best) return { topic: null, resolved: null, reason: "unresolved", considered, minSupply };

  const bestScore = weighed.find((w) => w.id === best)?.score ?? resolved.candidates[0]?.score ?? 0;
  if (!considered.some((c) => c.id === best)) considered.unshift({ id: best, score: bestScore, supply: supplyOf(best), eligible: true });

  if (supplyOf(best) >= minSupply) return { topic: best, resolved: best, reason: "best", considered, minSupply };

  const floor = bestScore * scoreFloor;
  const eligible = considered
    .filter((c) => c.eligible && c.id !== best && c.score !== null && c.score >= floor && c.supply >= minSupply)
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0) || b.supply - a.supply || a.id.localeCompare(b.id));
  const pick = eligible[0];
  if (pick) return { topic: pick.id, resolved: best, reason: "supply-aware", considered, minSupply };

  return { topic: best, resolved: best, reason: "no-supply", considered, minSupply };
}

/* ------------------------------------------------------------------------- */
/* Saying it                                                                  */
/* ------------------------------------------------------------------------- */

/** What the supply number counted — bodies on this machine, or every archive entry. */
export type SupplyBasis = "bodies" | "archive";

function candidateList(decision: TopicDecision): string {
  return decision.considered
    .map((c) => `${c.id}=${c.supply}${c.standInFor ? ` (for ${c.standInFor})` : ""}${c.eligible ? "" : " (generic-only)"}`)
    .join(", ");
}

function basisNoun(basis: SupplyBasis): string {
  return basis === "bodies" ? "usable transcripts" : "archive entries in family (no body source wired)";
}

/**
 * The one run-log line for the decision, e.g.
 * `topic: business/careers -> engineering (supply-aware: 0 vs 334 usable transcripts; candidates …)`.
 */
export function topicDecisionLine(decision: TopicDecision, basis: SupplyBasis): string {
  const noun = basisNoun(basis);
  const supplyOf = (id: string | null): number => decision.considered.find((c) => c.id === id)?.supply ?? 0;
  switch (decision.reason) {
    case "best":
      return `topic: ${decision.topic} (best: ${supplyOf(decision.topic)} ${noun}; candidates ${candidateList(decision)})`;
    case "supply-aware":
      return (
        `topic: ${decision.resolved} -> ${decision.topic} (supply-aware: ${supplyOf(decision.resolved)} vs ` +
        `${supplyOf(decision.topic)} ${noun}; candidates ${candidateList(decision)})`
      );
    case "no-supply":
      return `topic: ${decision.topic} — ${noSupplyReason(decision, basis)}`;
    case "unresolved":
      return `topic: unresolved (candidates ${candidateList(decision)})`;
    case "pinned":
      return `topic: ${decision.topic} (pinned by the caller; ${supplyOf(decision.topic)} ${noun})`;
  }
}

/** The stop reason a `no-supply` run reports — names every candidate and its count. */
export function noSupplyReason(decision: TopicDecision, basis: SupplyBasis): string {
  const what = basis === "bodies" ? "no transcript with a body on this machine" : "no transcript in the archive";
  return `NO SUPPLY: ${what} is in any candidate topic's family (need ${decision.minSupply}) — candidates: ${candidateList(decision)}`;
}
