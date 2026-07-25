import { describe, expect, it } from "vitest";
import { buildLadderSkeleton, type EnrichedEpisode } from "../src/curation/ladderBuilder";

/**
 * Unit tests for the deterministic, token-light ladder-assembly algorithm
 * (no I/O, no LLM — see ladderBuilder.ts's module docstring). Fixture-based
 * so they're independent of the real Fusion data in data/ladders.json
 * (that's covered end-to-end by ladderIntegrity.test.ts instead).
 */

const GOALS = {
  overview: "An overview goal line.",
  fundamentals: "A fundamentals goal line.",
  "deep-dive-alpha": "The alpha branch goal line.",
  "deep-dive-beta": "The beta branch goal line.",
  "deep-dive-general": "The undifferentiated deep-dive goal line.",
  frontier: "A frontier goal line."
};

function ep(over: Partial<EnrichedEpisode> & { id: string }): EnrichedEpisode {
  return {
    durationMin: 60,
    depth: "medium",
    format: "interview",
    releaseDate: "2024-01-01",
    ...over
  };
}

describe("buildLadderSkeleton", () => {
  it("throws on an empty episode pool rather than building a broken ladder", () => {
    expect(() => buildLadderSkeleton({ ladderId: "x", node: "n", title: "t", episodes: [], goals: {} })).toThrow();
  });

  it("throws when a produced rung has no goal text supplied (never invents prose)", () => {
    const episodes = [ep({ id: "a", depth: "high" })];
    expect(() => buildLadderSkeleton({ ladderId: "x", node: "n", title: "t", episodes, goals: {} })).toThrow(
      /no goal text/
    );
  });

  it("picks the shortest non-high-depth episode as overview when no roleHint is given", () => {
    const episodes = [
      ep({ id: "long-medium", durationMin: 90, depth: "medium" }),
      ep({ id: "short-medium", durationMin: 20, depth: "medium" }),
      ep({ id: "short-high", durationMin: 5, depth: "high" })
    ];
    const ladder = buildLadderSkeleton({ ladderId: "x", node: "n", title: "t", episodes, goals: GOALS });
    const overview = ladder.rungs.find((r) => r.id === "overview")!;
    expect(overview.episode_ids).toEqual(["short-medium"]);
  });

  it("falls back to the shortest episode overall when every episode is depth:high", () => {
    const episodes = [ep({ id: "a", durationMin: 40, depth: "high" }), ep({ id: "b", durationMin: 10, depth: "high" })];
    const ladder = buildLadderSkeleton({ ladderId: "x", node: "n", title: "t", episodes, goals: GOALS });
    expect(ladder.rungs.find((r) => r.id === "overview")!.episode_ids).toEqual(["b"]);
  });

  it("respects an explicit roleHint over the duration heuristic", () => {
    const episodes = [
      ep({ id: "shortest", durationMin: 5, depth: "medium" }),
      ep({ id: "chosen-overview", durationMin: 50, depth: "medium", roleHint: "overview" })
    ];
    const ladder = buildLadderSkeleton({ ladderId: "x", node: "n", title: "t", episodes, goals: GOALS });
    expect(ladder.rungs.find((r) => r.id === "overview")!.episode_ids).toEqual(["chosen-overview"]);
  });

  it("omits the fundamentals rung when only one episode exists (used entirely by overview)", () => {
    const episodes = [ep({ id: "only", depth: "medium" })];
    const ladder = buildLadderSkeleton({
      ladderId: "x",
      node: "n",
      title: "t",
      episodes,
      goals: { overview: "Solo overview goal." }
    });
    expect(ladder.rungs).toHaveLength(1);
    expect(ladder.rungs[0]!.id).toBe("overview");
  });

  it("buckets the deep-dive pool by subtopicKey into separate parallel branches", () => {
    const episodes = [
      ep({ id: "ov", durationMin: 10, depth: "medium", roleHint: "overview" }),
      ep({ id: "fund", durationMin: 15, depth: "medium", roleHint: "fundamentals" }),
      ep({ id: "a1", depth: "high", subtopicKey: "alpha", subtopicLabel: "Alpha" }),
      ep({ id: "a2", depth: "high", subtopicKey: "alpha", subtopicLabel: "Alpha", durationMin: 30 }),
      ep({ id: "b1", depth: "high", subtopicKey: "beta", subtopicLabel: "Beta" })
    ];
    const ladder = buildLadderSkeleton({ ladderId: "x", node: "n", title: "t", episodes, goals: GOALS });

    const alpha = ladder.rungs.find((r) => r.id === "deep-dive-alpha")!;
    const beta = ladder.rungs.find((r) => r.id === "deep-dive-beta")!;
    expect(alpha.subtopic).toBe("Alpha");
    expect(alpha.episode_ids).toEqual(["a2", "a1"]); // shorter (30min) before longer (60min default)
    expect(beta.episode_ids).toEqual(["b1"]);
    expect(alpha.prerequisites).toEqual(["fundamentals"]);
    expect(beta.prerequisites).toEqual(["fundamentals"]);
  });

  it("produces a single subtopic:null deep-dive rung when no episode has a subtopicKey", () => {
    const episodes = [
      ep({ id: "ov", durationMin: 10, roleHint: "overview" }),
      ep({ id: "fund", durationMin: 15, roleHint: "fundamentals" }),
      ep({ id: "d1", depth: "high" }),
      ep({ id: "d2", depth: "high" })
    ];
    const ladder = buildLadderSkeleton({
      ladderId: "x",
      node: "n",
      title: "t",
      episodes,
      goals: { ...GOALS, "deep-dive-general": GOALS["deep-dive-general"] }
    });
    const deepDiveRungs = ladder.rungs.filter((r) => r.level === "deep-dive");
    expect(deepDiveRungs).toHaveLength(1);
    expect(deepDiveRungs[0]!.subtopic).toBeNull();
    expect(deepDiveRungs[0]!.id).toBe("deep-dive-general");
  });

  it("frontier converges on every deep-dive branch (a real multi-parent DAG node)", () => {
    const episodes = [
      ep({ id: "ov", durationMin: 5, roleHint: "overview" }),
      ep({ id: "fund", durationMin: 10, roleHint: "fundamentals" }),
      ep({ id: "front", roleHint: "frontier" }),
      ep({ id: "a1", depth: "high", subtopicKey: "alpha" }),
      ep({ id: "b1", depth: "high", subtopicKey: "beta" })
    ];
    const ladder = buildLadderSkeleton({ ladderId: "x", node: "n", title: "t", episodes, goals: GOALS });
    const frontier = ladder.rungs.find((r) => r.id === "frontier")!;
    expect(frontier.episode_ids).toEqual(["front"]);
    expect(new Set(frontier.prerequisites)).toEqual(new Set(["deep-dive-alpha", "deep-dive-beta"]));
  });

  it("uses the most recent episodes for frontier when no roleHint is given, respecting the fraction/cap", () => {
    const episodes = [
      ep({ id: "ov", durationMin: 5, roleHint: "overview" }),
      ep({ id: "fund", durationMin: 10, roleHint: "fundamentals" }),
      ep({ id: "old", depth: "high", releaseDate: "2020-01-01" }),
      ep({ id: "mid", depth: "high", releaseDate: "2022-01-01" }),
      ep({ id: "new", depth: "high", releaseDate: "2024-01-01" }),
      ep({ id: "newest", depth: "high", releaseDate: "2025-01-01" })
    ];
    const ladder = buildLadderSkeleton({ ladderId: "x", node: "n", title: "t", episodes, goals: GOALS });
    const frontier = ladder.rungs.find((r) => r.id === "frontier");
    expect(frontier).toBeDefined();
    // 4 remaining episodes * 0.15 ~= 0.6 -> rounds to 1
    expect(frontier!.episode_ids).toEqual(["newest"]);
  });

  it("omits the frontier rung entirely when the remaining pool rounds to zero frontier picks", () => {
    const episodes = [
      ep({ id: "ov", durationMin: 5, roleHint: "overview" }),
      ep({ id: "fund", durationMin: 10, roleHint: "fundamentals" }),
      ep({ id: "d1", depth: "high" }) // 1 remaining * 0.15 rounds to 0
    ];
    const ladder = buildLadderSkeleton({
      ladderId: "x",
      node: "n",
      title: "t",
      episodes,
      goals: { overview: GOALS.overview, fundamentals: GOALS.fundamentals, "deep-dive-general": GOALS["deep-dive-general"] }
    });
    expect(ladder.rungs.find((r) => r.id === "frontier")).toBeUndefined();
  });

  it("wires prerequisites overview -> fundamentals -> branches, and sums estimated_total_min over every episode used", () => {
    const episodes = [
      ep({ id: "ov", durationMin: 10, roleHint: "overview" }),
      ep({ id: "fund", durationMin: 20, roleHint: "fundamentals" }),
      ep({ id: "d1", durationMin: 30, depth: "high", subtopicKey: "alpha" })
    ];
    const ladder = buildLadderSkeleton({ ladderId: "x", node: "n", title: "t", episodes, goals: GOALS });
    expect(ladder.rungs.find((r) => r.id === "overview")!.prerequisites).toEqual([]);
    expect(ladder.rungs.find((r) => r.id === "fundamentals")!.prerequisites).toEqual(["overview"]);
    expect(ladder.rungs.find((r) => r.id === "deep-dive-alpha")!.prerequisites).toEqual(["fundamentals"]);
    expect(ladder.estimated_total_min).toBe(60);
  });

  it("every produced ladder defaults to status draft", () => {
    const episodes = [ep({ id: "a" })];
    const ladder = buildLadderSkeleton({
      ladderId: "x",
      node: "n",
      title: "t",
      episodes,
      goals: { overview: GOALS.overview }
    });
    expect(ladder.status).toBe("draft");
  });
});
