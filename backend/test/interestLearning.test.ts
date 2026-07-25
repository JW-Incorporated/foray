import { describe, it, expect, beforeEach } from "vitest";
import {
  deriveInterestDeltas,
  dampedDelta,
  nextWeight,
  nextConfidence,
  computeCardIgnoredStreak,
  buildKnownNodeMap,
  applyEvent,
  applyEventBatch,
  IGNORED_CARD_SHOWN_THRESHOLD,
  STRETCH_NEGATIVE_DAMPING,
  type ApplyDeps
} from "../src/curation/interestLearning";
import { InMemoryTaxonomyRepository, InMemoryInterestAuditRepository } from "../src/curation/learningRepository";
import type { PersistedEvent } from "../src/curation/eventStore";

const USER = "11111111-1111-1111-1111-111111111111";
const FUSION = "engineering/energy-fusion";
const POLITICS = "news/politics";

let idCounter = 0;
function evt(partial: Partial<PersistedEvent> & Pick<PersistedEvent, "type" | "payload">): PersistedEvent {
  idCounter += 1;
  return {
    id: `evt-${idCounter}`,
    user_id: USER,
    ts: new Date(2026, 6, 24, 8, 0, idCounter).toISOString(),
    session_id: null,
    episode_id: null,
    archetype: null,
    ...partial
  } as PersistedEvent;
}

describe("deriveInterestDeltas", () => {
  it("finished >= 85% is a strong positive on topics", () => {
    const deltas = deriveInterestDeltas(
      evt({ type: "finished", payload: { episode_slug: "e1", topics: [FUSION], percent_complete: 0.9, source: "observed" } })
    );
    expect(deltas).toHaveLength(1);
    expect(deltas[0]).toMatchObject({ nodeId: FUSION, reason: "finished_strong", durable: true });
    expect(deltas[0]!.delta).toBeGreaterThan(0);
  });

  it("finished < 85% produces no signal", () => {
    const deltas = deriveInterestDeltas(
      evt({ type: "finished", payload: { episode_slug: "e1", topics: [FUSION], percent_complete: 0.5, source: "observed" } })
    );
    expect(deltas).toHaveLength(0);
  });

  it("picked is a mild positive, even before listening", () => {
    const deltas = deriveInterestDeltas(
      evt({ type: "picked", payload: { episode_slug: "e1", topics: [FUSION], archetype: "deep-learn" } })
    );
    expect(deltas[0]).toMatchObject({ nodeId: FUSION, reason: "picked_from_menu", durable: true });
    expect(deltas[0]!.delta).toBeGreaterThan(0);
    expect(deltas[0]!.delta).toBeLessThan(0.08); // milder than a finish
  });

  it("skip < 2min is a weak negative on topic", () => {
    const deltas = deriveInterestDeltas(
      evt({ type: "skipped_at", payload: { episode_slug: "e1", topics: [FUSION], elapsed_seconds: 45 } })
    );
    expect(deltas[0]).toMatchObject({ nodeId: FUSION, reason: "skip_strong_neg", durable: true });
    expect(deltas[0]!.delta).toBeLessThan(0);
  });

  it("skip 2-20min is a milder negative than skip < 2min", () => {
    const early = deriveInterestDeltas(evt({ type: "skipped_at", payload: { episode_slug: "e1", topics: [FUSION], elapsed_seconds: 60 } }));
    const mid = deriveInterestDeltas(evt({ type: "skipped_at", payload: { episode_slug: "e1", topics: [FUSION], elapsed_seconds: 600 } }));
    expect(Math.abs(mid[0]!.delta)).toBeLessThan(Math.abs(early[0]!.delta));
  });

  it("skip >= 20min is not treated as a skip signal", () => {
    const deltas = deriveInterestDeltas(evt({ type: "skipped_at", payload: { episode_slug: "e1", topics: [FUSION], elapsed_seconds: 1300 } }));
    expect(deltas).toHaveLength(0);
  });

  it("voice_command more_like_this is a strong positive on the named node", () => {
    const deltas = deriveInterestDeltas(evt({ type: "voice_command", payload: { command: "more_like_this", node_id: FUSION } }));
    expect(deltas[0]).toMatchObject({ nodeId: FUSION, reason: "more_like_this", durable: true });
    expect(deltas[0]!.delta).toBeGreaterThan(0);
  });

  it("voice_command less_x is a medium negative on the named node", () => {
    const deltas = deriveInterestDeltas(evt({ type: "voice_command", payload: { command: "less_x", node_id: POLITICS } }));
    expect(deltas[0]).toMatchObject({ nodeId: POLITICS, reason: "thumbs_down_named_node", durable: true });
    expect(deltas[0]!.delta).toBeLessThan(0);
  });

  it("voice_command something_different is audited but NOT durable (critical invariant)", () => {
    const deltas = deriveInterestDeltas(evt({ type: "voice_command", payload: { command: "something_different", node_id: FUSION } }));
    expect(deltas).toHaveLength(1);
    expect(deltas[0]!.durable).toBe(false);
    expect(deltas[0]!.delta).toBe(0);
  });

  it("voice_command never_this_show produces no node-level delta (out of scope — show blocklist)", () => {
    const deltas = deriveInterestDeltas(evt({ type: "voice_command", payload: { command: "never_this_show", show: "Some Show" } }));
    expect(deltas).toHaveLength(0);
  });

  it("thumbs down is a medium negative on the named node", () => {
    const deltas = deriveInterestDeltas(evt({ type: "thumbs", payload: { direction: "down", node_id: POLITICS } }));
    expect(deltas[0]).toMatchObject({ nodeId: POLITICS, reason: "thumbs_down_named_node", durable: true });
    expect(deltas[0]!.delta).toBeLessThan(0);
  });

  it("thumbs up reuses the more_like_this reason (approved overload, no enum migration)", () => {
    const deltas = deriveInterestDeltas(evt({ type: "thumbs", payload: { direction: "up", node_id: FUSION } }));
    expect(deltas[0]).toMatchObject({ nodeId: FUSION, reason: "more_like_this", durable: true });
    expect(deltas[0]!.delta).toBeGreaterThan(0);
  });

  it("saved is a positive on topic, and produces no episode/now-context signal", () => {
    const deltas = deriveInterestDeltas(evt({ type: "saved", payload: { episode_slug: "e1", topics: [FUSION] } }));
    expect(deltas[0]).toMatchObject({ nodeId: FUSION, reason: "saved_for_later", durable: true });
    expect(deltas[0]!.delta).toBeGreaterThan(0);
  });

  it("card_shown below the ignored threshold produces no signal", () => {
    const deltas = deriveInterestDeltas(
      evt({ type: "card_shown", payload: { episode_slug: "e1", topics: [FUSION], archetype: "stretch" } }),
      { ignoredCardShownCount: IGNORED_CARD_SHOWN_THRESHOLD - 1 }
    );
    expect(deltas).toHaveLength(0);
  });

  it("card_shown at/above the ignored threshold is a gentle negative", () => {
    const deltas = deriveInterestDeltas(
      evt({ type: "card_shown", payload: { episode_slug: "e1", topics: [FUSION], archetype: "stretch" } }),
      { ignoredCardShownCount: IGNORED_CARD_SHOWN_THRESHOLD }
    );
    expect(deltas[0]).toMatchObject({ nodeId: FUSION, reason: "card_ignored_repeatedly", durable: true });
    expect(deltas[0]!.delta).toBeLessThan(0);
  });

  it("session_built and session_rated produce no node-weight signal (analytics only)", () => {
    expect(deriveInterestDeltas(evt({ type: "session_built", payload: { session_key: "k", builder: "b" } }))).toHaveLength(0);
    expect(deriveInterestDeltas(evt({ type: "session_rated", payload: { session_key: "k", rating: "good" } }))).toHaveLength(0);
  });
});

describe("dampedDelta — Stretch-slot negative-signal damping (curation-practices.md sec.4)", () => {
  it("damps a negative delta sourced from the stretch slot", () => {
    expect(dampedDelta(-0.1, "stretch")).toBeCloseTo(-0.1 * STRETCH_NEGATIVE_DAMPING, 10);
  });

  it("does not damp a negative delta from deep-learn", () => {
    expect(dampedDelta(-0.1, "deep-learn")).toBe(-0.1);
  });

  it("does not damp a positive delta from stretch (a serendipity hit counts fully)", () => {
    expect(dampedDelta(0.1, "stretch")).toBe(0.1);
  });
});

describe("nextWeight / nextConfidence — clamping", () => {
  it("clamps weight to [-1, 1]", () => {
    expect(nextWeight(0.97, 0.5)).toBe(1);
    expect(nextWeight(-0.97, -0.5)).toBe(-1);
  });

  it("clamps confidence to [0, 1] and only ever increases from a durable signal", () => {
    expect(nextConfidence(0.99)).toBe(1);
    expect(nextConfidence(0)).toBeGreaterThan(0);
  });
});

describe("computeCardIgnoredStreak", () => {
  it("counts consecutive topic-overlapping card_shown events, including the current one", () => {
    const history: PersistedEvent[] = [
      evt({ type: "card_shown", payload: { episode_slug: "e1", topics: [FUSION], archetype: "stretch" } }),
      evt({ type: "card_shown", payload: { episode_slug: "e2", topics: [FUSION], archetype: "stretch" } }),
      evt({ type: "card_shown", payload: { episode_slug: "e3", topics: [FUSION], archetype: "stretch" } })
    ];
    const current = evt({ type: "card_shown", payload: { episode_slug: "e4", topics: [FUSION], archetype: "stretch" } });
    expect(computeCardIgnoredStreak(history, current)).toBe(4);
  });

  it("resets the streak at an intervening pick with overlapping topics", () => {
    const history: PersistedEvent[] = [
      evt({ type: "card_shown", payload: { episode_slug: "e1", topics: [FUSION], archetype: "stretch" } }),
      evt({ type: "picked", payload: { episode_slug: "e1", topics: [FUSION], archetype: "stretch" } }),
      evt({ type: "card_shown", payload: { episode_slug: "e2", topics: [FUSION], archetype: "stretch" } })
    ];
    const current = evt({ type: "card_shown", payload: { episode_slug: "e3", topics: [FUSION], archetype: "stretch" } });
    expect(computeCardIgnoredStreak(history, current)).toBe(2);
  });

  it("ignores card_shown events with no topic overlap", () => {
    const history: PersistedEvent[] = [evt({ type: "card_shown", payload: { episode_slug: "e1", topics: [POLITICS], archetype: "stretch" } })];
    const current = evt({ type: "card_shown", payload: { episode_slug: "e2", topics: [FUSION], archetype: "stretch" } });
    expect(computeCardIgnoredStreak(history, current)).toBe(1);
  });
});

describe("buildKnownNodeMap", () => {
  it("maps node id -> label from a taxonomy file", () => {
    const map = buildKnownNodeMap({
      version: 1,
      nodes: [{ id: FUSION, parent: "engineering", label: "Fusion", apple_anchor: null, weight: 0, confidence: 0, last_evidence_at: "2026-01-01" }],
      episode_attributes: { depth: ["low", "medium", "high"], format: ["interview"], evergreen: "boolean" }
    });
    expect(map.get(FUSION)).toEqual({ label: "Fusion" });
  });
});

describe("applyEvent — orchestration against in-memory repositories", () => {
  let taxonomyRepo: InMemoryTaxonomyRepository;
  let auditRepo: InMemoryInterestAuditRepository;
  let deps: ApplyDeps;

  beforeEach(() => {
    taxonomyRepo = new InMemoryTaxonomyRepository();
    auditRepo = new InMemoryInterestAuditRepository();
    deps = { taxonomyRepo, auditRepo, knownNodes: new Map([[FUSION, { label: "Fusion" }]]) };
  });

  it("writes taxonomy_nodes and an audit row for a durable signal", async () => {
    const event = evt({ type: "finished", payload: { episode_slug: "e1", topics: [FUSION], percent_complete: 0.9, source: "observed" } });
    const outcome = await applyEvent(event, deps);

    expect(outcome.applied).toHaveLength(1);
    expect(outcome.skipped).toHaveLength(0);

    const node = await taxonomyRepo.getNode(USER, FUSION);
    expect(node?.weight).toBeGreaterThan(0);
    expect(node?.confidence).toBeGreaterThan(0);

    const audit = auditRepo.all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ nodeId: FUSION, reason: "finished_strong", sourceEventId: event.id });
    expect(audit[0]!.previousWeight).toBe(0);
    expect(audit[0]!.newWeight).toBeGreaterThan(0);
  });

  it("audits but does not mutate taxonomy_nodes for something_different", async () => {
    taxonomyRepo.seed({ user_id: USER, node_id: FUSION, weight: 0.4, confidence: 0.5, last_evidence_at: null });
    const event = evt({ type: "voice_command", payload: { command: "something_different", node_id: FUSION } });

    const outcome = await applyEvent(event, deps);
    expect(outcome.applied).toEqual([{ nodeId: FUSION, reason: "something_different", delta: 0, durable: false }]);

    const node = await taxonomyRepo.getNode(USER, FUSION);
    expect(node?.weight).toBe(0.4); // unchanged — the critical invariant

    const audit = auditRepo.all();
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ delta: 0, previousWeight: 0.4, newWeight: 0.4 });
  });

  it("skips a delta targeting a node outside the known taxonomy, without writing anything", async () => {
    const event = evt({ type: "voice_command", payload: { command: "more_like_this", node_id: "not/a-real-node" } });
    const outcome = await applyEvent(event, deps);

    expect(outcome.applied).toHaveLength(0);
    expect(outcome.skipped).toEqual([{ nodeId: "not/a-real-node", why: "not in known taxonomy" }]);
    expect(await taxonomyRepo.getNode(USER, "not/a-real-node")).toBeUndefined();
    expect(auditRepo.all()).toHaveLength(0);
  });

  it("applies Stretch-slot damping to a negative delta end-to-end", async () => {
    taxonomyRepo.seed({ user_id: USER, node_id: FUSION, weight: 0, confidence: 0, last_evidence_at: null });
    const stretchEvent = evt({ archetype: "stretch", type: "skipped_at", payload: { episode_slug: "e1", topics: [FUSION], elapsed_seconds: 30 } });
    await applyEvent(stretchEvent, deps);
    const dampedNode = await taxonomyRepo.getNode(USER, FUSION);

    taxonomyRepo.seed({ user_id: USER, node_id: FUSION, weight: 0, confidence: 0, last_evidence_at: null });
    const deepLearnEvent = evt({ archetype: "deep-learn", type: "skipped_at", payload: { episode_slug: "e2", topics: [FUSION], elapsed_seconds: 30 } });
    await applyEvent(deepLearnEvent, deps);
    const undampedNode = await taxonomyRepo.getNode(USER, FUSION);

    expect(Math.abs(dampedNode!.weight)).toBeLessThan(Math.abs(undampedNode!.weight));
  });

  it("applyEventBatch computes the ignored-card-shown streak from prior events in the same batch", async () => {
    const events = [
      evt({ type: "card_shown", payload: { episode_slug: "e1", topics: [FUSION], archetype: "stretch" } }),
      evt({ type: "card_shown", payload: { episode_slug: "e2", topics: [FUSION], archetype: "stretch" } }),
      evt({ type: "card_shown", payload: { episode_slug: "e3", topics: [FUSION], archetype: "stretch" } }),
      evt({ type: "card_shown", payload: { episode_slug: "e4", topics: [FUSION], archetype: "stretch" } }),
      evt({ type: "card_shown", payload: { episode_slug: "e5", topics: [FUSION], archetype: "stretch" } })
    ];
    const outcomes = await applyEventBatch(events, deps);
    // only the 5th card_shown (streak == threshold) should produce a signal
    expect(outcomes.slice(0, 4).every((o) => o.applied.length === 0)).toBe(true);
    expect(outcomes[4]!.applied).toHaveLength(1);
    expect(outcomes[4]!.applied[0]).toMatchObject({ reason: "card_ignored_repeatedly" });
  });
});
