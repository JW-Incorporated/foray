/**
 * Cost metering (01_PROMPT.md constraint #8, corner case 33). Every
 * LLM/TTS/transcription call site must call `costEvents.record()` — this is
 * the single write path into what becomes the `cost_events` table.
 *
 * The sink is pluggable so tests and dry-run CLI usage never need a live
 * Postgres connection: `InMemoryCostEventSink` is the default. A Postgres
 * sink can be swapped in later (backend/migrations/0010_cost_events.sql
 * defines the target shape) without changing any call site.
 */

export interface CostEventInput {
  userId: string;
  operation: string; // e.g. 'tier1_classify' | 'tier2_transcript' | 'tts_generate' | 'voice_intent' | 'why_line'
  provider: string; // 'anthropic' | 'stub' | ...
  model?: string;
  tokensInput?: number;
  tokensOutput?: number;
  units?: number;
  estimatedUsd: number;
  episodeId?: string;
  sessionId?: string;
  dryRun?: boolean;
}

export interface CostEventRecord extends CostEventInput {
  id: string;
  ts: string;
}

export interface CostEventSink {
  record(input: CostEventInput): Promise<CostEventRecord>;
  sumUsdSince(userId: string, sinceIso: string): Promise<number>;
  sumUsdSinceByTier?(userId: string, sinceIso: string, operationPrefix: string): Promise<number>;
  /**
   * Sum of estimatedUsd for all cost events sharing the given sessionId,
   * across all time. `sessionId` (not `episodeId`) is the id that scopes
   * "one Foray's generation run" — the 4 generation-pipeline builders
   * (AnthropicPromptUnderstander, AnthropicSpineBuilder,
   * AnthropicDeepenActBuilder, AnthropicExternalResearcher) all populate
   * `sessionId: ctx.sessionId` for exactly this purpose. `episodeId` is
   * already a distinct, populated concept — the *catalogue* episode being
   * enriched by the separate enrichment pipeline (enrich/AnthropicEnricher.ts,
   * enrich/Enricher.ts) — so reusing it here would collide two unrelated
   * ids. A Foray's generation run is bounded in wall-clock duration, so no
   * "since" cutoff is needed the way the daily user cap needs one.
   * Optional: sinks that don't implement this can't back the per-episode
   * (per-Foray) budget path in BudgetGuard, which then degrades to a
   * no-op for that path — existing daily-cap behavior is unaffected.
   */
  sumUsdBySession?(sessionId: string): Promise<number>;
  all(): Promise<CostEventRecord[]>;
}

let idCounter = 0;
function nextId(): string {
  idCounter += 1;
  return `cost-evt-${idCounter}-${Date.now()}`;
}

export class InMemoryCostEventSink implements CostEventSink {
  private readonly events: CostEventRecord[] = [];

  async record(input: CostEventInput): Promise<CostEventRecord> {
    const record: CostEventRecord = { ...input, id: nextId(), ts: new Date().toISOString() };
    this.events.push(record);
    return record;
  }

  async sumUsdSince(userId: string, sinceIso: string): Promise<number> {
    const since = new Date(sinceIso).getTime();
    return this.events
      .filter((e) => e.userId === userId && new Date(e.ts).getTime() >= since)
      .reduce((sum, e) => sum + e.estimatedUsd, 0);
  }

  async sumUsdSinceByTier(userId: string, sinceIso: string, operationPrefix: string): Promise<number> {
    const since = new Date(sinceIso).getTime();
    return this.events
      .filter(
        (e) => e.userId === userId && new Date(e.ts).getTime() >= since && e.operation.startsWith(operationPrefix)
      )
      .reduce((sum, e) => sum + e.estimatedUsd, 0);
  }

  async sumUsdBySession(sessionId: string): Promise<number> {
    return this.events.filter((e) => e.sessionId === sessionId).reduce((sum, e) => sum + e.estimatedUsd, 0);
  }

  async all(): Promise<CostEventRecord[]> {
    return [...this.events];
  }

  reset(): void {
    this.events.length = 0;
  }
}

/** Process-wide default sink; CLI/tests may construct their own instance instead. */
export const defaultCostEventSink = new InMemoryCostEventSink();

export const costEvents = {
  record: (input: CostEventInput) => defaultCostEventSink.record(input)
};

/** Start-of-day (local time) ISO string — "today" boundary for budget checks. */
export function startOfLocalDayIso(now: Date = new Date()): string {
  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 0, 0, 0, 0);
  return start.toISOString();
}
