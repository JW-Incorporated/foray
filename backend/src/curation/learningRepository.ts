import type { Client } from "pg";
import type { InterestReason } from "./interestLearning";

/**
 * Write path for the interest-learning job: `taxonomy_nodes` (current
 * weight, 0005_taxonomy_nodes.sql) + `user_interests` (append-only audit
 * log, 0006_user_interests.sql). Pluggable-sink pattern, matching
 * `src/cost/costEvents.ts` / `src/curation/eventStore.ts`.
 *
 * NOTE (coordination, 2026-07-24): a sibling task ("per-user weights /
 * personas") also writes `taxonomy_nodes`/`user_interests`, for a different
 * operation (persona-seed rows at onboarding, reason='onboarding'). This
 * module is intentionally a separate, independent repository for the
 * learning job's own writes (reason set drawn from the observed-signal
 * table, never 'onboarding') — unifying the two write paths is deferred to
 * a follow-up once both land.
 *
 * `user_interests.episode_id` (uuid FK) is left null for the same reason as
 * `events.episode_id` — see docs/DECISIONS.md — episode identity here is a
 * catalogue slug, not a row in the `episodes` table.
 */

export interface TaxonomyNodeRow {
  user_id: string;
  node_id: string;
  weight: number;
  confidence: number;
  last_evidence_at: string | null;
}

export interface TaxonomyRepository {
  getNode(userId: string, nodeId: string): Promise<TaxonomyNodeRow | undefined>;

  /**
   * Upserts weight/confidence/last_evidence_at. When the node row doesn't
   * exist yet for this user (e.g. the learning job runs before any seeding
   * pass has populated it), creates it with the given label and
   * source='inferred' — durable learning never invents an unlabeled node;
   * the label must come from the known taxonomy (see
   * `buildKnownNodeMap` in interestLearning.ts).
   */
  setWeightAndConfidence(input: {
    userId: string;
    nodeId: string;
    label: string;
    weight: number;
    confidence: number;
    lastEvidenceAtIso: string;
  }): Promise<void>;
}

export interface InterestAuditRow {
  userId: string;
  nodeId: string;
  reason: InterestReason;
  archetypeSlot: string | null;
  delta: number;
  previousWeight: number | null;
  newWeight: number | null;
  sourceEventId: string | null;
}

export interface InterestAuditRepository {
  append(row: InterestAuditRow): Promise<void>;
}

export class InMemoryTaxonomyRepository implements TaxonomyRepository {
  private readonly nodes = new Map<string, TaxonomyNodeRow>();

  private key(userId: string, nodeId: string): string {
    return `${userId}::${nodeId}`;
  }

  /** Test helper — seed an existing node row (e.g. a prior persona seed). */
  seed(row: TaxonomyNodeRow): void {
    this.nodes.set(this.key(row.user_id, row.node_id), row);
  }

  async getNode(userId: string, nodeId: string): Promise<TaxonomyNodeRow | undefined> {
    return this.nodes.get(this.key(userId, nodeId));
  }

  async setWeightAndConfidence(input: {
    userId: string;
    nodeId: string;
    label: string;
    weight: number;
    confidence: number;
    lastEvidenceAtIso: string;
  }): Promise<void> {
    this.nodes.set(this.key(input.userId, input.nodeId), {
      user_id: input.userId,
      node_id: input.nodeId,
      weight: input.weight,
      confidence: input.confidence,
      last_evidence_at: input.lastEvidenceAtIso
    });
  }

  reset(): void {
    this.nodes.clear();
  }
}

export class InMemoryInterestAuditRepository implements InterestAuditRepository {
  private readonly rows: InterestAuditRow[] = [];

  async append(row: InterestAuditRow): Promise<void> {
    this.rows.push(row);
  }

  all(): InterestAuditRow[] {
    return [...this.rows];
  }

  reset(): void {
    this.rows.length = 0;
  }
}

/** Service-role Postgres-backed repositories — used by the learning job CLI only. */
export class PostgresTaxonomyRepository implements TaxonomyRepository {
  constructor(private readonly client: Client) {}

  async getNode(userId: string, nodeId: string): Promise<TaxonomyNodeRow | undefined> {
    const result = await this.client.query<{
      user_id: string;
      node_id: string;
      weight: string;
      confidence: string;
      last_evidence_at: string | null;
    }>(`select user_id, node_id, weight, confidence, last_evidence_at from taxonomy_nodes where user_id = $1 and node_id = $2`, [
      userId,
      nodeId
    ]);
    const row = result.rows[0];
    if (!row) return undefined;
    return {
      user_id: row.user_id,
      node_id: row.node_id,
      weight: Number(row.weight),
      confidence: Number(row.confidence),
      last_evidence_at: row.last_evidence_at
    };
  }

  async setWeightAndConfidence(input: {
    userId: string;
    nodeId: string;
    label: string;
    weight: number;
    confidence: number;
    lastEvidenceAtIso: string;
  }): Promise<void> {
    await this.client.query(
      `insert into taxonomy_nodes (user_id, node_id, label, weight, confidence, last_evidence_at, source)
       values ($1, $2, $3, $4, $5, $6, 'inferred')
       on conflict (user_id, node_id) do update
         set weight = excluded.weight,
             confidence = excluded.confidence,
             last_evidence_at = excluded.last_evidence_at,
             updated_at = now()`,
      [input.userId, input.nodeId, input.label, input.weight, input.confidence, input.lastEvidenceAtIso]
    );
  }
}

export class PostgresInterestAuditRepository implements InterestAuditRepository {
  constructor(private readonly client: Client) {}

  async append(row: InterestAuditRow): Promise<void> {
    await this.client.query(
      `insert into user_interests
         (user_id, node_id, reason, archetype_slot, delta, previous_weight, new_weight, source_event_id)
       values ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        row.userId,
        row.nodeId,
        row.reason,
        row.archetypeSlot,
        row.delta,
        row.previousWeight,
        row.newWeight,
        row.sourceEventId
      ]
    );
  }
}
