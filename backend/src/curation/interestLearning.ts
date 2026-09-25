import type { PersistedEvent } from "./eventStore";
import type { InterestAuditRepository, TaxonomyRepository } from "./learningRepository";
import type { TaxonomyFile } from "../types/taxonomy";

/**
 * Signal -> interest-weight learning job (personalization-and-depth-plan.md
 * Step C; the table this implements is 03_CURATION_SPEC.md "Learning from
 * signals"). Scope boundary (deliberate, see the plan handed off with this
 * work): `taxonomy_nodes`/`user_interests` are NODE/TOPIC-scoped only. The
 * spec's per-episode and per-format skip penalties are NOT node-scoped —
 * those live in `curation/scoring.ts`'s fatigue computation, which reads
 * raw event history at query time. This module never touches per-episode
 * or per-show state; it only nudges durable topic weights.
 *
 * Critical invariant carried over from 03_CURATION_SPEC.md: "something
 * different" and session/mood context must NEVER permanently mutate taste.
 * Such signals are still audited (an `InterestDelta` with `durable: false`
 * produces a zero-delta `user_interests` row) but never reach
 * `taxonomy_nodes.weight`.
 */

export type InterestReason =
  | "onboarding"
  | "finished_strong"
  | "picked_from_menu"
  | "skip_strong_neg"
  | "skip_weak_neg"
  | "more_like_this"
  | "something_different"
  | "thumbs_down_named_node"
  | "saved_for_later"
  | "card_ignored_repeatedly"
  | "manual_edit";

export interface InterestDelta {
  nodeId: string;
  reason: InterestReason;
  /** Raw, pre-damping signed weight change. */
  delta: number;
  /** false => audited (user_interests row written) but taxonomy_nodes.weight is NOT mutated. */
  durable: boolean;
  archetypeSlot: string | null;
}

export interface DeriveContext {
  /**
   * Per topic of the current card_shown: how many times a card carrying that
   * topic has been shown (including this one) since the topic was last
   * picked, per 03_CURATION_SPEC.md: "Card shown, never picked x5 -> gentle -
   * on that framing/topic". Computed by the caller with `CardShownStreaks`
   * over the batch it fetched (the streak does not look further back than
   * the current learning_cursor window; documented in docs/DECISIONS.md).
   * Each topic is judged on its OWN count (round-3 review, L6): a topic just
   * picked is never penalised because a sibling topic on the same card hit
   * its fifth showing, and no topic's fifth showing is hidden behind a
   * sibling's higher count.
   */
  ignoredCardShownCounts?: ReadonlyMap<string, number>;
  /**
   * One streak for every topic on the card. Used only when
   * `ignoredCardShownCounts` is absent (a caller with a single number).
   */
  ignoredCardShownCount?: number;
}

// Base magnitudes — starting points per 03_CURATION_SPEC.md ("weights are
// starting points; tune from my data"), not tuned against real data yet.
const FINISHED_STRONG = 0.08;
const PICKED_FROM_MENU = 0.02;
const SKIP_STRONG_TOPIC = 0.02; // the topic-level component of "skip < 2min" (episode-level component is out of node scope)
const SKIP_WEAK_TOPIC = 0.01; // the topic-level component of "skip 2-20min" (format-level component is out of node scope)
const MORE_LIKE_THIS = 0.1;
const LESS_X = 0.15;
const THUMBS_DOWN = 0.1;
/**
 * The down-vote reasons that are ABOUT THE SUBJECT (audit round 2, p-foray-6,
 * and its review; docs/DECISIONS.md 2026-09-23: "A down-vote moves the
 * subject's weight only when its reason is about the subject"). app.js's
 * `TOPIC_REASONS` is the same set, character for character —
 * test/listener-copy.test.js reads both files and pins them together. A
 * down-vote for "Bad audio quality" or "Didn't like the voice" is audited with
 * no weight change; the client's fix alone left the learning job lowering the
 * subject for a complaint about one host's microphone.
 */
export const TOPIC_DOWNVOTE_REASONS: readonly string[] = ["Not my subject", "Too surface-level", "Too in-the-weeds"];
const THUMBS_UP = 0.1; // reuses the 'more_like_this' reason code (approved 2026-07-24 — no enum migration for this)
const SAVED_FOR_LATER = 0.04;
const CARD_IGNORED = 0.01;

export const IGNORED_CARD_SHOWN_THRESHOLD = 5;

/** Stretch-slot negative signal is damped relative to Deep-learn (curation-practices.md sec.4). */
export const STRETCH_NEGATIVE_DAMPING = 0.4;

function clamp(min: number, max: number, v: number): number {
  return Math.max(min, Math.min(max, v));
}

/** Applies the Stretch-slot damping rule to an already-derived delta. */
export function dampedDelta(delta: number, archetypeSlot: string | null): number {
  if (delta < 0 && archetypeSlot === "stretch") return delta * STRETCH_NEGATIVE_DAMPING;
  return delta;
}

export function nextWeight(previousWeight: number, appliedDelta: number): number {
  return clamp(-1, 1, previousWeight + appliedDelta);
}

const CONFIDENCE_GAIN = 0.02;
export function nextConfidence(previousConfidence: number): number {
  return clamp(0, 1, previousConfidence + CONFIDENCE_GAIN);
}

/** One thumbs vote's move on its node. A down-vote moves the subject only for
    a reason about the subject (TOPIC_DOWNVOTE_REASONS); any other down is
    audited with no weight change. */
function thumbsVoteDeltas(nodeId: string, direction: "up" | "down", reasons: readonly string[] | undefined, slot: string | null): InterestDelta[] {
  if (direction === "down") {
    const rs = Array.isArray(reasons) ? reasons : [];
    if (!rs.some((r) => TOPIC_DOWNVOTE_REASONS.includes(r))) {
      return [{ nodeId, reason: "thumbs_down_named_node", delta: 0, durable: false, archetypeSlot: slot }];
    }
    return [{ nodeId, reason: "thumbs_down_named_node", delta: -THUMBS_DOWN, durable: true, archetypeSlot: slot }];
  }
  return [{ nodeId, reason: "more_like_this", delta: THUMBS_UP, durable: true, archetypeSlot: slot }];
}

/**
 * Pure derivation: event -> zero or more node-level deltas. Never touches
 * storage. `event.archetype` (the row-level slot-provenance column) is
 * preferred for damping context; falls back to the payload's own
 * `archetype` field for card_shown/picked, which carry it directly.
 */
export function deriveInterestDeltas(event: PersistedEvent, ctx: DeriveContext = {}): InterestDelta[] {
  const slot = (event.archetype as string | null) ?? null;

  switch (event.type) {
    case "finished": {
      const p = event.payload;
      if (p.percent_complete < 0.85) return [];
      return p.topics.map((nodeId) => ({ nodeId, reason: "finished_strong" as const, delta: FINISHED_STRONG, durable: true, archetypeSlot: slot }));
    }

    case "picked": {
      const p = event.payload;
      const pickedSlot = slot ?? p.archetype ?? null;
      return p.topics.map((nodeId) => ({ nodeId, reason: "picked_from_menu" as const, delta: PICKED_FROM_MENU, durable: true, archetypeSlot: pickedSlot }));
    }

    case "skipped_at": {
      const p = event.payload;
      if (p.elapsed_seconds < 120) {
        return p.topics.map((nodeId) => ({ nodeId, reason: "skip_strong_neg" as const, delta: -SKIP_STRONG_TOPIC, durable: true, archetypeSlot: slot }));
      }
      if (p.elapsed_seconds < 1200) {
        return p.topics.map((nodeId) => ({ nodeId, reason: "skip_weak_neg" as const, delta: -SKIP_WEAK_TOPIC, durable: true, archetypeSlot: slot }));
      }
      return []; // 20min+ isn't a skip signal per the spec table
    }

    case "voice_command": {
      const p = event.payload;
      if (p.command === "more_like_this") {
        if (!p.node_id) return [];
        return [{ nodeId: p.node_id, reason: "more_like_this" as const, delta: MORE_LIKE_THIS, durable: true, archetypeSlot: slot }];
      }
      if (p.command === "less_x") {
        if (!p.node_id) return [];
        return [{ nodeId: p.node_id, reason: "thumbs_down_named_node" as const, delta: -LESS_X, durable: true, archetypeSlot: slot }];
      }
      if (p.command === "something_different") {
        // Critical invariant: contextual/mood signal, must not permanently mutate taste.
        if (!p.node_id) return [];
        return [{ nodeId: p.node_id, reason: "something_different" as const, delta: 0, durable: false, archetypeSlot: slot }];
      }
      // 'never_this_show' is a show blocklist, not a taxonomy-node concept — out of scope
      // (docs/DECISIONS.md: needs its own small table, deferred).
      return [];
    }

    case "thumbs": {
      const p = event.payload;
      /* A CHANGED OR WITHDRAWN VOTE TAKES THE OLD ONE'S MOVE BACK (round-3
         audit, app-2-6). The client logs the vote it replaced; without this,
         up, clear, up reached this job as three ups and moved the subject three
         times. The undo reuses the replaced vote's own reason code with the
         opposite sign (no new reason, so no user_interests enum migration),
         and a replaced vote that moved nothing (a non-subject down) has
         nothing to undo. */
      const undo = p.replaces
        ? thumbsVoteDeltas(p.node_id, p.replaces.direction, p.replaces.reasons, slot)
            .filter((d) => d.durable)
            .map((d) => ({ ...d, delta: -d.delta }))
        : [];
      if (p.direction === "cleared") return undo;
      return [...undo, ...thumbsVoteDeltas(p.node_id, p.direction, p.reasons, slot)];
    }

    case "saved": {
      const p = event.payload;
      return p.topics.map((nodeId) => ({ nodeId, reason: "saved_for_later" as const, delta: SAVED_FOR_LATER, durable: true, archetypeSlot: slot }));
    }

    case "card_shown": {
      const p = event.payload;
      // "x5 -> gentle -": once per THRESHOLD showings, not on every showing
      // after the 5th (backend-rest-17: a card shown 25 times was penalised
      // 21 times rather than 5).
      const fires = (streak: number): boolean => streak >= IGNORED_CARD_SHOWN_THRESHOLD && streak % IGNORED_CARD_SHOWN_THRESHOLD === 0;
      const shownSlot = slot ?? p.archetype ?? null;
      const perTopic = ctx.ignoredCardShownCounts;
      return [...new Set(p.topics)]
        .filter((nodeId) => fires(perTopic ? perTopic.get(nodeId) ?? 0 : ctx.ignoredCardShownCount ?? 0))
        .map((nodeId) => ({ nodeId, reason: "card_ignored_repeatedly" as const, delta: -CARD_IGNORED, durable: true, archetypeSlot: shownSlot }));
    }

    case "session_built":
    case "session_rated":
      return []; // analytics-only, no node-weight effect (confirmed 2026-07-24)

    default:
      return [];
  }
}

/**
 * Builds the node_id -> label lookup deltas are validated/labeled against,
 * from the single global taxonomy file (personalization-and-depth-plan.md
 * §5: "one taxonomy for both catalogue and preferences"). A node_id that
 * doesn't appear here is not a real node — its delta is skipped, not
 * invented (see `applyEvent`).
 */
export function buildKnownNodeMap(taxonomy: TaxonomyFile): Map<string, { label: string }> {
  return new Map(taxonomy.nodes.map((n) => [n.id, { label: n.label }]));
}

export interface ApplyDeps {
  taxonomyRepo: TaxonomyRepository;
  auditRepo: InterestAuditRepository;
  /** node_id -> label, from the known taxonomy (data/taxonomy.json). Deltas targeting an unknown node_id are skipped, not invented. */
  knownNodes: Map<string, { label: string }>;
}

export interface AppliedDeltaOutcome {
  nodeId: string;
  reason: InterestReason;
  delta: number;
  durable: boolean;
}

export interface SkippedDeltaOutcome {
  nodeId: string;
  why: string;
}

export interface ApplyEventOutcome {
  eventId: string;
  applied: AppliedDeltaOutcome[];
  skipped: SkippedDeltaOutcome[];
}

/**
 * Orchestrates derive -> (skip unknown nodes) -> (damp) -> write taxonomy_nodes
 * + user_interests for one event. This is the function the job loop calls
 * per fetched event, in ts order.
 */
export async function applyEvent(event: PersistedEvent, deps: ApplyDeps, ctx: DeriveContext = {}): Promise<ApplyEventOutcome> {
  const deltas = deriveInterestDeltas(event, ctx);
  const applied: AppliedDeltaOutcome[] = [];
  const skipped: SkippedDeltaOutcome[] = [];

  for (const d of deltas) {
    if (!deps.knownNodes.has(d.nodeId)) {
      skipped.push({ nodeId: d.nodeId, why: "not in known taxonomy" });
      continue;
    }

    if (!d.durable) {
      const existing = await deps.taxonomyRepo.getNode(event.user_id, d.nodeId);
      await deps.auditRepo.append({
        userId: event.user_id,
        nodeId: d.nodeId,
        reason: d.reason,
        archetypeSlot: d.archetypeSlot,
        delta: 0,
        previousWeight: existing?.weight ?? null,
        newWeight: existing?.weight ?? null,
        sourceEventId: event.id
      });
      applied.push({ nodeId: d.nodeId, reason: d.reason, delta: 0, durable: false });
      continue;
    }

    const damped = dampedDelta(d.delta, d.archetypeSlot);
    const existing = await deps.taxonomyRepo.getNode(event.user_id, d.nodeId);
    const previousWeight = existing?.weight ?? 0;
    const previousConfidence = existing?.confidence ?? 0;
    const newWeight = nextWeight(previousWeight, damped);
    const newConfidence = nextConfidence(previousConfidence);
    const label = deps.knownNodes.get(d.nodeId)!.label;

    await deps.taxonomyRepo.setWeightAndConfidence({
      userId: event.user_id,
      nodeId: d.nodeId,
      label,
      weight: newWeight,
      confidence: newConfidence,
      lastEvidenceAtIso: event.ts
    });
    await deps.auditRepo.append({
      userId: event.user_id,
      nodeId: d.nodeId,
      reason: d.reason,
      archetypeSlot: d.archetypeSlot,
      delta: damped,
      previousWeight,
      newWeight,
      sourceEventId: event.id
    });
    applied.push({ nodeId: d.nodeId, reason: d.reason, delta: damped, durable: true });
  }

  return { eventId: event.id, applied, skipped };
}

/**
 * Runs the full derive+apply loop over an already-fetched, ts-ordered batch
 * of events for one user. `card_shown` streak context is computed from the
 * same batch by `CardShownStreaks`, per topic.
 */
export async function applyEventBatch(events: PersistedEvent[], deps: ApplyDeps): Promise<ApplyEventOutcome[]> {
  const outcomes: ApplyEventOutcome[] = [];
  const streaks = new CardShownStreaks();
  for (const event of events) {
    const ctx: DeriveContext = event.type === "card_shown" ? { ignoredCardShownCounts: streaks.observeCounts(event) } : {};
    if (event.type === "picked") streaks.observe(event);
    outcomes.push(await applyEvent(event, deps, ctx));
  }
  return outcomes;
}

/**
 * Running per-user, per-topic count of card_shown events since that topic was
 * last picked: one pass over the batch instead of slicing and rescanning it
 * for every card_shown (backend-rest-17, which was O(n^2) copying). A pick
 * resets the counts of the topics it carries. Each topic's count is judged on
 * its own (`observeCounts`); `observe` reports the highest, for callers that
 * want one number.
 */
export class CardShownStreaks {
  private readonly counts = new Map<string, Map<string, number>>();

  /** Records a card_shown or picked event; returns a card_shown's highest per-topic streak (0 for anything else). */
  observe(event: PersistedEvent): number {
    let streak = 0;
    for (const n of this.observeCounts(event).values()) streak = Math.max(streak, n);
    return streak;
  }

  /** Records a card_shown or picked event; returns a card_shown's count per topic (empty for anything else). */
  observeCounts(event: PersistedEvent): Map<string, number> {
    const out = new Map<string, number>();
    let perTopic = this.counts.get(event.user_id);
    if (!perTopic) {
      perTopic = new Map();
      this.counts.set(event.user_id, perTopic);
    }
    if (event.type === "picked") {
      for (const t of event.payload.topics) perTopic.delete(t);
      return out;
    }
    if (event.type !== "card_shown") return out;
    for (const t of new Set(event.payload.topics)) {
      const n = (perTopic.get(t) ?? 0) + 1;
      perTopic.set(t, n);
      out.set(t, n);
    }
    return out;
  }
}
