/**
 * Cost metering (01_PROMPT.md constraint #8, corner case 33). Every metered
 * LLM call goes through `BudgetGuard.checkAndRecord`, which records here.
 *
 * The only sink is `InMemoryCostEventSink`: spend lives in this process and
 * dies with it, which is why the guard's cap is a per-process RUN budget
 * (`RUN_BUDGET_USD`) and not a daily one. Nothing writes the
 * `cost_events` table (backend/migrations/0010_cost_events.sql), and it is not
 * a drop-in target: its FK columns cannot hold the ids recorded here. A shared
 * sink is not built until a multi-process generator exists (docs/DECISIONS.md
 * 2026-10-07); the table's own fate is a separate schema ruling.
 */

export interface CostEventInput {
  userId: string;
  operation: string; // a label for the run log, e.g. 'spine_build' | 'narrate' | 'why_line'; it never changes the cap
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
  /** Sum of estimatedUsd over every event this sink holds — for the in-memory
   * sink, everything this process has spent. The RUN cap compares against it. */
  sumUsd(): Promise<number>;
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
   * ids. Optional: sinks that don't implement this can't back the
   * per-episode (per-Foray) budget path in BudgetGuard, which then degrades
   * to a no-op for that path — the run cap is unaffected.
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

  async sumUsd(): Promise<number> {
    return this.events.reduce((sum, e) => sum + e.estimatedUsd, 0);
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
