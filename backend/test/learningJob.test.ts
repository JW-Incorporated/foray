import { describe, it, expect, beforeEach } from "vitest";
import { runLearningJobForUser } from "../src/curation/learningJob";
import { InMemoryEventStore } from "../src/curation/eventStore";
import { InMemoryLearningCursorStore } from "../src/curation/learningCursor";
import { InMemoryTaxonomyRepository, InMemoryInterestAuditRepository } from "../src/curation/learningRepository";
import type { ApplyDeps } from "../src/curation/interestLearning";

const USER = "22222222-2222-2222-2222-222222222222";
const FUSION = "engineering/energy-fusion";

describe("runLearningJobForUser — end to end over in-memory stores", () => {
  let eventStore: InMemoryEventStore;
  let cursorStore: InMemoryLearningCursorStore;
  let taxonomyRepo: InMemoryTaxonomyRepository;
  let auditRepo: InMemoryInterestAuditRepository;
  let applyDeps: ApplyDeps;

  beforeEach(() => {
    eventStore = new InMemoryEventStore();
    cursorStore = new InMemoryLearningCursorStore();
    taxonomyRepo = new InMemoryTaxonomyRepository();
    auditRepo = new InMemoryInterestAuditRepository();
    applyDeps = { taxonomyRepo, auditRepo, knownNodes: new Map([[FUSION, { label: "Fusion" }]]) };
  });

  it("processes a user's events, writes durable weight updates, and advances the cursor", async () => {
    await eventStore.record({
      user_id: USER,
      type: "finished",
      payload: { episode_slug: "e1", topics: [FUSION], percent_complete: 0.95, source: "observed" }
    });
    await eventStore.record({
      user_id: USER,
      type: "saved",
      payload: { episode_slug: "e2", topics: [FUSION] }
    });

    const result = await runLearningJobForUser(USER, { eventStore, cursorStore, applyDeps });

    expect(result.eventsProcessed).toBe(2);
    expect(result.cursorAdvancedTo).not.toBeNull();

    const node = await taxonomyRepo.getNode(USER, FUSION);
    expect(node?.weight).toBeGreaterThan(0);
    expect(auditRepo.all()).toHaveLength(2);

    const cursor = await cursorStore.get(USER);
    expect(cursor).toBeDefined();
  });

  it("is idempotent: a second run with no new events processes nothing and leaves state unchanged", async () => {
    await eventStore.record({
      user_id: USER,
      type: "finished",
      payload: { episode_slug: "e1", topics: [FUSION], percent_complete: 0.95, source: "observed" }
    });

    const first = await runLearningJobForUser(USER, { eventStore, cursorStore, applyDeps });
    expect(first.eventsProcessed).toBe(1);
    const weightAfterFirst = (await taxonomyRepo.getNode(USER, FUSION))?.weight;

    const second = await runLearningJobForUser(USER, { eventStore, cursorStore, applyDeps });
    expect(second.eventsProcessed).toBe(0);
    expect(second.cursorAdvancedTo).toBeNull();
    expect((await taxonomyRepo.getNode(USER, FUSION))?.weight).toBe(weightAfterFirst);
    expect(auditRepo.all()).toHaveLength(1); // no duplicate audit row from the second run
  });

  it("only processes events strictly after the cursor on a subsequent run", async () => {
    await eventStore.record({
      user_id: USER,
      type: "saved",
      payload: { episode_slug: "e1", topics: [FUSION] }
    });
    await runLearningJobForUser(USER, { eventStore, cursorStore, applyDeps });

    await eventStore.record({
      user_id: USER,
      type: "saved",
      payload: { episode_slug: "e2", topics: [FUSION] }
    });
    const second = await runLearningJobForUser(USER, { eventStore, cursorStore, applyDeps });

    expect(second.eventsProcessed).toBe(1);
    expect(auditRepo.all()).toHaveLength(2);
  });

  it("returns an empty result for a user with no events at all", async () => {
    const result = await runLearningJobForUser("no-such-user-yet", { eventStore, cursorStore, applyDeps });
    expect(result.eventsProcessed).toBe(0);
    expect(result.outcomes).toHaveLength(0);
  });
});
