import type { EventPage, EventStore, InvalidEventRow } from "./eventStore";
import type { LearningCursorStore } from "./learningCursor";
import { applyEventBatch, CardShownStreaks, type ApplyDeps, type ApplyEventOutcome } from "./interestLearning";

/**
 * Ties eventStore + learning_cursor + interestLearning together into one
 * resumable per-user run: page through every event since the cursor, apply
 * them in order, advance the cursor past each page. One run catches a user
 * up however many pages they are behind (CH2-05, B2-17). Mirrors how
 * `curation/sessionBuilder.ts` wraps `scoring.ts`/`archetypes.ts` — this
 * module is the orchestration layer; `interestLearning.ts` stays pure.
 */

export interface LearningJobResult {
  userId: string;
  eventsProcessed: number;
  outcomes: ApplyEventOutcome[];
  /** Rows that failed the event contract: skipped, but the cursor moves past them. */
  invalidEvents: InvalidEventRow[];
  cursorAdvancedTo: { ts: string; id: string } | null;
}

/**
 * Runs `fn` atomically. The Postgres CLI passes BEGIN/COMMIT/ROLLBACK on the
 * one shared client, so a user's weight writes, audit rows and cursor moves,
 * across every page of the run, land together or not at all: a throw part-way through used to leave the
 * early events applied and the cursor unmoved, so the next run applied them
 * twice (backend-rest-3). In-memory callers can omit it.
 */
export type RunInTransaction = <T>(fn: () => Promise<T>) => Promise<T>;

const runDirectly: RunInTransaction = (fn) => fn();

export async function runLearningJobForUser(
  userId: string,
  deps: {
    eventStore: EventStore;
    cursorStore: LearningCursorStore;
    applyDeps: ApplyDeps;
    transaction?: RunInTransaction;
  },
  batchSize = 1000
): Promise<LearningJobResult> {
  const transaction = deps.transaction ?? runDirectly;
  return transaction(async () => {
    const cursor = await deps.cursorStore.get(userId);
    let after: { ts: string; id: string } | null = cursor ? { ts: cursor.lastEventTs, id: cursor.lastEventId } : null;
    let eventsProcessed = 0;
    const outcomes: ApplyEventOutcome[] = [];
    const invalidEvents: InvalidEventRow[] = [];
    let cursorAdvancedTo: { ts: string; id: string } | null = null;
    // One streak tracker for the whole run, so a card_shown streak split at
    // a page boundary still fires.
    const streaks = new CardShownStreaks();

    let page: EventPage;
    do {
      page = await deps.eventStore.fetchPage(userId, after?.ts ?? null, after?.id ?? null, batchSize);
      if (page.last === null) break;

      outcomes.push(...(await applyEventBatch(page.events, deps.applyDeps, streaks)));
      eventsProcessed += page.events.length;
      invalidEvents.push(...page.invalid);

      // The cursor moves past the last row FETCHED, valid or not, so a
      // malformed row is skipped once rather than re-read on every run.
      await deps.cursorStore.set(userId, { lastEventTs: page.last.ts, lastEventId: page.last.id });
      after = cursorAdvancedTo = { ts: page.last.ts, id: page.last.id };
    } while (page.events.length + page.invalid.length === batchSize);

    return { userId, eventsProcessed, outcomes, invalidEvents, cursorAdvancedTo };
  });
}

export interface LearningRunSummary {
  results: LearningJobResult[];
  failures: Array<{ userId: string; error: string }>;
}

/**
 * Runs the job for every user, one at a time. One user's failure is recorded
 * and the rest still run (backend-rest-3: the CLI's bare loop used to abort
 * every later user on the first throw). The caller exits non-zero when
 * `failures` is non-empty.
 */
export async function runLearningJobForUsers(
  userIds: string[],
  deps: Parameters<typeof runLearningJobForUser>[1],
  batchSize = 1000
): Promise<LearningRunSummary> {
  const results: LearningJobResult[] = [];
  const failures: LearningRunSummary["failures"] = [];
  for (const userId of userIds) {
    try {
      results.push(await runLearningJobForUser(userId, deps, batchSize));
    } catch (err) {
      failures.push({ userId, error: err instanceof Error ? err.message : String(err) });
    }
  }
  return { results, failures };
}
