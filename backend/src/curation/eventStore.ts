import type { Client } from "pg";
import { parseEventRow, type EventRow } from "../types/events";

/**
 * Read/write access to the `events` table (0009_events.sql). Pluggable-sink
 * pattern, matching `src/cost/costEvents.ts`: `InMemoryEventStore` is the
 * default for tests and dry-run CLI usage; `PostgresEventStore` is a thin
 * `pg` wrapper used by the interest-learning job (service-role connection,
 * same convention as `cli/migrate.ts`).
 *
 * Per the approved contract decision (docs/DECISIONS.md, "events FK columns
 * are decorative until catalogue-ingest exists"): `episode_id`/`session_id`
 * are always written as null here. Durable identity lives in
 * `payload.episode_slug` / `payload.session_key`.
 */

// A type alias (not `interface extends`), because EventRow is a discriminated
// union under an intersection (via EventRowSchema's `.and()`) — interfaces
// can't extend that shape, but a type alias preserves the union so `.type`
// narrowing (see interestLearning.ts) still works on payload.
export type PersistedEvent = EventRow & {
  id: string;
  ts: string;
};

export interface EventStore {
  /** Validates and persists one event row. */
  record(input: EventRow): Promise<PersistedEvent>;

  /**
   * Events for a user strictly after the given (ts, id) cursor, ordered
   * ascending by (ts, id) — the learning job's read path. `afterId` breaks
   * ties among events sharing the same `ts` so none are skipped or
   * reprocessed at a cursor boundary. Pass `afterTs: null` to fetch a
   * user's full history (first run / no cursor yet).
   */
  fetchSince(userId: string, afterTs: string | null, afterId: string | null, limit?: number): Promise<PersistedEvent[]>;

  /** Test/debug helper — every event ever recorded, insertion order. */
  all(): Promise<PersistedEvent[]>;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  // Not a real uuid — fine for the in-memory test double, which never
  // touches a uuid-typed column.
  return `evt-${idCounter}-${Date.now()}`;
}

export class InMemoryEventStore implements EventStore {
  private readonly events: PersistedEvent[] = [];

  async record(input: EventRow): Promise<PersistedEvent> {
    const validated = parseEventRow(input);
    const record: PersistedEvent = {
      ...validated,
      id: validated.id ?? nextId(),
      ts: validated.ts ?? new Date().toISOString()
    };
    this.events.push(record);
    return record;
  }

  async fetchSince(
    userId: string,
    afterTs: string | null,
    afterId: string | null,
    limit = 1000
  ): Promise<PersistedEvent[]> {
    const afterTsMs = afterTs ? new Date(afterTs).getTime() : -Infinity;
    return this.events
      .filter((e) => {
        if (e.user_id !== userId) return false;
        const ts = new Date(e.ts).getTime();
        if (ts !== afterTsMs) return ts > afterTsMs;
        // tie-break on id when timestamps are equal
        return afterId !== null && e.id > afterId;
      })
      .sort((a, b) => new Date(a.ts).getTime() - new Date(b.ts).getTime() || (a.id < b.id ? -1 : 1))
      .slice(0, limit);
  }

  async all(): Promise<PersistedEvent[]> {
    return [...this.events];
  }

  reset(): void {
    this.events.length = 0;
  }
}

/** Service-role Postgres-backed store — used by the learning job, never by client code. */
export class PostgresEventStore implements EventStore {
  constructor(private readonly client: Client) {}

  async record(input: EventRow): Promise<PersistedEvent> {
    const validated = parseEventRow(input);
    const result = await this.client.query<{
      id: string;
      user_id: string;
      ts: string;
      type: string;
      session_id: string | null;
      episode_id: string | null;
      archetype: string | null;
      payload: unknown;
    }>(
      `insert into events (user_id, type, session_id, episode_id, archetype, payload)
       values ($1, $2, $3, $4, $5, $6)
       returning id, user_id, ts, type, session_id, episode_id, archetype, payload`,
      [
        validated.user_id,
        validated.type,
        validated.session_id ?? null,
        validated.episode_id ?? null,
        validated.archetype ?? null,
        JSON.stringify(validated.payload)
      ]
    );
    const row = result.rows[0]!;
    return {
      ...validated,
      id: row.id,
      ts: new Date(row.ts).toISOString()
    } as PersistedEvent;
  }

  async fetchSince(
    userId: string,
    afterTs: string | null,
    afterId: string | null,
    limit = 1000
  ): Promise<PersistedEvent[]> {
    const result = await this.client.query<{
      id: string;
      user_id: string;
      ts: string;
      type: string;
      session_id: string | null;
      episode_id: string | null;
      archetype: string | null;
      payload: unknown;
    }>(
      `select id, user_id, ts, type, session_id, episode_id, archetype, payload
       from events
       where user_id = $1
         and (
           $2::timestamptz is null
           or ts > $2::timestamptz
           or (ts = $2::timestamptz and id > coalesce($3::uuid, '00000000-0000-0000-0000-000000000000'::uuid))
         )
       order by ts asc, id asc
       limit $4`,
      [userId, afterTs, afterId, limit]
    );
    return result.rows.map(
      (row) =>
        ({
          id: row.id,
          user_id: row.user_id,
          ts: new Date(row.ts).toISOString(),
          type: row.type,
          session_id: row.session_id as null,
          episode_id: row.episode_id as null,
          archetype: row.archetype,
          payload: row.payload
        }) as PersistedEvent
    );
  }

  /** Debug helper only (small fixtures/manual inspection) — the job never calls this. */
  async all(): Promise<PersistedEvent[]> {
    const result = await this.client.query<{
      id: string;
      user_id: string;
      ts: string;
      type: string;
      session_id: string | null;
      episode_id: string | null;
      archetype: string | null;
      payload: unknown;
    }>(`select id, user_id, ts, type, session_id, episode_id, archetype, payload from events order by ts asc, id asc limit 10000`);
    return result.rows.map(
      (row) =>
        ({
          id: row.id,
          user_id: row.user_id,
          ts: new Date(row.ts).toISOString(),
          type: row.type,
          session_id: row.session_id as null,
          episode_id: row.episode_id as null,
          archetype: row.archetype,
          payload: row.payload
        }) as PersistedEvent
    );
  }
}
