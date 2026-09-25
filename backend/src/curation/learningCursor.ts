import type { Client } from "pg";

/**
 * Per-user high-water mark into `events` (0015_learning_cursor.sql) so the
 * interest-learning job never rescans full history and never double-applies
 * an already-processed event. Pluggable-sink pattern, matching
 * `eventStore.ts` / `learningRepository.ts`.
 */

export interface LearningCursor {
  lastEventTs: string;
  lastEventId: string;
}

export interface LearningCursorStore {
  get(userId: string): Promise<LearningCursor | undefined>;
  set(userId: string, cursor: LearningCursor): Promise<void>;
}

export class InMemoryLearningCursorStore implements LearningCursorStore {
  private readonly cursors = new Map<string, LearningCursor>();

  async get(userId: string): Promise<LearningCursor | undefined> {
    return this.cursors.get(userId);
  }

  async set(userId: string, cursor: LearningCursor): Promise<void> {
    this.cursors.set(userId, cursor);
  }

  reset(): void {
    this.cursors.clear();
  }
}

export class PostgresLearningCursorStore implements LearningCursorStore {
  constructor(private readonly client: Client) {}

  async get(userId: string): Promise<LearningCursor | undefined> {
    // Read as microsecond text, never through a JS Date: a Date truncates to
    // milliseconds and `ts > cursor` would then re-select the last event on
    // every run (backend-rest-2).
    const result = await this.client.query<{ last_event_ts_text: string; last_event_id: string }>(
      `select to_char(last_event_ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as last_event_ts_text,
              last_event_id
       from learning_cursor where user_id = $1`,
      [userId]
    );
    const row = result.rows[0];
    if (!row) return undefined;
    return { lastEventTs: row.last_event_ts_text, lastEventId: row.last_event_id };
  }

  async set(userId: string, cursor: LearningCursor): Promise<void> {
    await this.client.query(
      `insert into learning_cursor (user_id, last_event_ts, last_event_id, updated_at)
       values ($1, $2, $3, now())
       on conflict (user_id) do update
         set last_event_ts = excluded.last_event_ts,
             last_event_id = excluded.last_event_id,
             updated_at = now()`,
      [userId, cursor.lastEventTs, cursor.lastEventId]
    );
  }
}
