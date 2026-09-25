import type { Client } from "pg";
import { parseEventRow, safeParseEventRow, type EventRow } from "../types/events";

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

/** A fetched row that failed the event contract (backend-rest-3). */
export interface InvalidEventRow {
  id: string;
  ts: string;
  reason: string;
}

/**
 * One page of a user's events after a cursor. `events` holds only rows that
 * pass the event contract; `invalid` the ones that did not. `last` is the
 * (ts, id) of the last row fetched, VALID OR NOT, so the job can move its
 * cursor past a malformed row instead of re-reading it on every run.
 */
export interface EventPage {
  events: PersistedEvent[];
  invalid: InvalidEventRow[];
  last: { ts: string; id: string } | null;
}

/**
 * Postgres timestamptz is microsecond-precise; a JS Date is not. The cursor
 * must carry the full value, or `ts > cursor` re-selects the last event on
 * every run (backend-rest-2). So ts is always read as this text.
 */
export const TS_TEXT_SQL = `to_char(ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * Validates one raw row against the event contract. Never throws: a row a
 * client wrote with no topics, or topics as a string, used to crash the
 * learning job and stall the user's cursor for good (backend-rest-3).
 */
export function toPersistedEvent(
  row: { id: string; ts: string } & Record<string, unknown>
): { ok: true; event: PersistedEvent } | { ok: false; invalid: InvalidEventRow } {
  /* The shipped web client puts a card's slot in the row's `archetype`
     column, not in the payload the contract puts it in (events-client-
     integration-spec.md, the `picked` row's "add archetype" note). Read it
     from the column when the payload lacks it, so a real pick is not thrown
     away over where one field was written. */
  const payload = row.payload;
  const input =
    payload && typeof payload === "object" && !Array.isArray(payload) && (payload as Record<string, unknown>).archetype === undefined && typeof row.archetype === "string"
      ? { ...row, payload: { ...(payload as Record<string, unknown>), archetype: row.archetype } }
      : row;
  const parsed = safeParseEventRow(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const reason = issue ? `${issue.path.join(".") || "(row)"}: ${issue.message}` : "invalid event row";
    return { ok: false, invalid: { id: row.id, ts: row.ts, reason } };
  }
  return { ok: true, event: { ...parsed.data, id: row.id, ts: row.ts } as PersistedEvent };
}

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

  /** fetchSince plus the rows that failed validation and the last (ts, id) fetched — the learning job's read path. */
  fetchPage(userId: string, afterTs: string | null, afterId: string | null, limit?: number): Promise<EventPage>;

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

  async fetchPage(userId: string, afterTs: string | null, afterId: string | null, limit = 1000): Promise<EventPage> {
    const events = await this.fetchSince(userId, afterTs, afterId, limit);
    const last = events[events.length - 1];
    return { events, invalid: [], last: last ? { ts: last.ts, id: last.id } : null };
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
      ts_text: string;
      type: string;
      session_id: string | null;
      episode_id: string | null;
      archetype: string | null;
      payload: unknown;
    }>(
      `insert into events (user_id, type, session_id, episode_id, archetype, payload)
       values ($1, $2, $3, $4, $5, $6)
       returning id, user_id, ${TS_TEXT_SQL} as ts_text, type, session_id, episode_id, archetype, payload`,
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
      ts: row.ts_text
    } as PersistedEvent;
  }

  async fetchSince(
    userId: string,
    afterTs: string | null,
    afterId: string | null,
    limit = 1000
  ): Promise<PersistedEvent[]> {
    return (await this.fetchPage(userId, afterTs, afterId, limit)).events;
  }

  async fetchPage(userId: string, afterTs: string | null, afterId: string | null, limit = 1000): Promise<EventPage> {
    const result = await this.client.query<{
      id: string;
      user_id: string;
      ts_text: string;
      type: string;
      session_id: string | null;
      episode_id: string | null;
      archetype: string | null;
      payload: unknown;
    }>(
      `select id, user_id, ${TS_TEXT_SQL} as ts_text, type, session_id, episode_id, archetype, payload
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
    const events: PersistedEvent[] = [];
    const invalid: InvalidEventRow[] = [];
    for (const row of result.rows) {
      const checked = toPersistedEvent({
        id: row.id,
        user_id: row.user_id,
        ts: row.ts_text,
        type: row.type,
        session_id: row.session_id,
        episode_id: row.episode_id,
        archetype: row.archetype,
        payload: row.payload
      });
      if (checked.ok) events.push(checked.event);
      else invalid.push(checked.invalid);
    }
    const lastRow = result.rows[result.rows.length - 1];
    return { events, invalid, last: lastRow ? { ts: lastRow.ts_text, id: lastRow.id } : null };
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
