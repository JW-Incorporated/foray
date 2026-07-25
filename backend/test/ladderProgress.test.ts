import { describe, expect, it } from "vitest";
import { inferLadderProgress } from "../src/curation/ladderProgress";
import type { Ladder } from "../src/types/ladders";

/**
 * Reference-algorithm tests for entry-rung inference (observed, never
 * declared — CLAUDE.md #2). The future client-integration pass
 * (docs/curation/ladders-client-spec.md) should port this exact logic, so
 * these tests double as the executable spec for what "correct" means.
 */

function ladder(rungs: Ladder["rungs"]): Ladder {
  return {
    id: "test-ladder",
    node: "engineering/energy-fusion",
    title: "Test ladder",
    status: "draft",
    estimated_total_min: 100,
    rungs
  };
}

describe("inferLadderProgress", () => {
  it("a listener with no history is recommended the root rung", () => {
    const l = ladder([
      { id: "overview", level: "overview", subtopic: null, goal: "g", episode_ids: ["a"], prerequisites: [] },
      { id: "fundamentals", level: "fundamentals", subtopic: null, goal: "g", episode_ids: ["b"], prerequisites: ["overview"] }
    ]);
    const progress = inferLadderProgress(l, []);
    expect(progress.reachedRungIds).toEqual([]);
    expect(progress.entryRungId).toBe("overview");
    expect(progress.rootRungIds).toEqual(["overview"]);
  });

  it("reaching overview recommends fundamentals next", () => {
    const l = ladder([
      { id: "overview", level: "overview", subtopic: null, goal: "g", episode_ids: ["a"], prerequisites: [] },
      { id: "fundamentals", level: "fundamentals", subtopic: null, goal: "g", episode_ids: ["b"], prerequisites: ["overview"] }
    ]);
    const progress = inferLadderProgress(l, ["a"]);
    expect(progress.reachedRungIds).toEqual(["overview"]);
    expect(progress.entryRungId).toBe("fundamentals");
  });

  it("rung reached = ANY ONE episode picked, not all of them", () => {
    const l = ladder([
      {
        id: "deep-dive-tokamak",
        level: "deep-dive",
        subtopic: "Tokamak",
        goal: "g",
        episode_ids: ["x", "y", "z"],
        prerequisites: []
      }
    ]);
    const progress = inferLadderProgress(l, ["y"]);
    expect(progress.reachedRungIds).toEqual(["deep-dive-tokamak"]);
  });

  it("prefers an unexplored parallel branch over a multi-parent convergence rung", () => {
    const l = ladder([
      { id: "fund", level: "fundamentals", subtopic: null, goal: "g", episode_ids: ["f"], prerequisites: [] },
      { id: "branch-a", level: "deep-dive", subtopic: "A", goal: "g", episode_ids: ["a"], prerequisites: ["fund"] },
      { id: "branch-b", level: "deep-dive", subtopic: "B", goal: "g", episode_ids: ["b"], prerequisites: ["fund"] },
      {
        id: "frontier",
        level: "frontier",
        subtopic: null,
        goal: "g",
        episode_ids: ["z"],
        prerequisites: ["branch-a", "branch-b"]
      }
    ]);
    // Reached fund and branch-a only (never touched branch-b). Even though
    // frontier's any-one-of prerequisite rule is already satisfied (branch-a
    // is reached), the entry rung is branch-b, not frontier: the walk visits
    // rungs in topological order and recommends the earliest untouched one,
    // so an unexplored parallel branch always wins over jumping straight to
    // a convergence rung. This is intentional and on-brand (CLAUDE.md #1,
    // curiosity-first / anti-echo-chamber): the algorithm nudges toward
    // breadth across the curriculum before narrowing to "where things stand."
    const progress = inferLadderProgress(l, ["f", "a"]);
    expect(progress.reachedRungIds.sort()).toEqual(["branch-a", "fund"]);
    expect(progress.entryRungId).toBe("branch-b");
  });

  it("recommends the multi-parent convergence rung once every parallel branch is reached", () => {
    const l = ladder([
      { id: "fund", level: "fundamentals", subtopic: null, goal: "g", episode_ids: ["f"], prerequisites: [] },
      { id: "branch-a", level: "deep-dive", subtopic: "A", goal: "g", episode_ids: ["a"], prerequisites: ["fund"] },
      { id: "branch-b", level: "deep-dive", subtopic: "B", goal: "g", episode_ids: ["b"], prerequisites: ["fund"] },
      {
        id: "frontier",
        level: "frontier",
        subtopic: null,
        goal: "g",
        episode_ids: ["z"],
        prerequisites: ["branch-a", "branch-b"]
      }
    ]);
    const progress = inferLadderProgress(l, ["f", "a", "b"]);
    expect(progress.entryRungId).toBe("frontier");
  });

  it("returns entryRungId: null once every rung is reached", () => {
    const l = ladder([
      { id: "overview", level: "overview", subtopic: null, goal: "g", episode_ids: ["a"], prerequisites: [] },
      { id: "fundamentals", level: "fundamentals", subtopic: null, goal: "g", episode_ids: ["b"], prerequisites: ["overview"] }
    ]);
    const progress = inferLadderProgress(l, ["a", "b"]);
    expect(progress.entryRungId).toBeNull();
  });

  it("never recommends a rung whose prerequisites are all unreached", () => {
    const l = ladder([
      { id: "overview", level: "overview", subtopic: null, goal: "g", episode_ids: ["a"], prerequisites: [] },
      { id: "fundamentals", level: "fundamentals", subtopic: null, goal: "g", episode_ids: ["b"], prerequisites: ["overview"] },
      { id: "deep-dive", level: "deep-dive", subtopic: null, goal: "g", episode_ids: ["c"], prerequisites: ["fundamentals"] }
    ]);
    // No history at all — must recommend overview, never skip ahead to
    // fundamentals or deep-dive just because they're "later" in the array.
    const progress = inferLadderProgress(l, []);
    expect(progress.entryRungId).toBe("overview");
  });

  it("is defensive against a malformed cyclic prerequisite graph (never throws)", () => {
    const l = ladder([
      { id: "a", level: "overview", subtopic: null, goal: "g", episode_ids: ["1"], prerequisites: ["b"] },
      { id: "b", level: "fundamentals", subtopic: null, goal: "g", episode_ids: ["2"], prerequisites: ["a"] }
    ]);
    expect(() => inferLadderProgress(l, [])).not.toThrow();
  });
});
