import type { EventStore } from "./eventStore";
import type { LearningCursorStore } from "./learningCursor";
import { applyEventBatch, type ApplyDeps, type ApplyEventOutcome } from "./interestLearning";

/**
 * Ties eventStore + learning_cursor + interestLearning together into one
 * resumable per-user run: fetch events since the cursor, apply them in
 * order, advance the cursor to the last event processed. Mirrors how
 * `curation/sessionBuilder.ts` wraps `scoring.ts`/`archetypes.ts` — this
 * module is the orchestration layer; `interestLearning.ts` stays pure.
 */

export interface LearningJobResult {
  userId: string;
  eventsProcessed: number;
  outcomes: ApplyEventOutcome[];
  cursorAdvancedTo: { ts: string; id: string } | null;
}

export async function runLearningJobForUser(
  userId: string,
  deps: {
    eventStore: EventStore;
    cursorStore: LearningCursorStore;
    applyDeps: ApplyDeps;
  },
  batchSize = 1000
): Promise<LearningJobResult> {
  const cursor = await deps.cursorStore.get(userId);
  const events = await deps.eventStore.fetchSince(userId, cursor?.lastEventTs ?? null, cursor?.lastEventId ?? null, batchSize);

  if (events.length === 0) {
    return { userId, eventsProcessed: 0, outcomes: [], cursorAdvancedTo: null };
  }

  const outcomes = await applyEventBatch(events, deps.applyDeps);

  const last = events[events.length - 1]!;
  await deps.cursorStore.set(userId, { lastEventTs: last.ts, lastEventId: last.id });

  return {
    userId,
    eventsProcessed: events.length,
    outcomes,
    cursorAdvancedTo: { ts: last.ts, id: last.id }
  };
}
