import { describe, expect, it } from "vitest";
import {
  InMemoryUserInterestsProvider,
  materializePersonaSeedRows,
  resolveEffectiveTaxonomy,
  type UserTaxonomyRow
} from "../src/curation/userInterests";
import { createUserInterestsProvider } from "../src/curation/createUserInterestsProvider";
import { env } from "../src/config/env";
import type { TaxonomyFile } from "../src/types/taxonomy";
import type { Persona } from "../src/types/personas";

const TAXONOMY: TaxonomyFile = {
  version: 1,
  nodes: [
    { id: "engineering", parent: null, label: "Engineering", apple_anchor: "Science", weight: 0.9, confidence: 0.9, last_evidence_at: "2026-07-01" },
    { id: "engineering/energy-fusion", parent: "engineering", label: "Fusion", apple_anchor: "Science", weight: 1.0, confidence: 0.95, last_evidence_at: "2026-07-01" },
    { id: "comedy", parent: null, label: "Comedy", apple_anchor: "Comedy", weight: 0.6, confidence: 0.7, last_evidence_at: "2026-07-01" },
    { id: "news", parent: null, label: "News", apple_anchor: "News", weight: -0.8, confidence: 0.5, last_evidence_at: "2026-07-01" }
  ],
  episode_attributes: { depth: ["low", "medium", "high"], format: ["interview"], evergreen: "boolean" }
};

const PERSONA: Persona = {
  id: "generalist",
  label: "Generalist",
  description: "Broad curiosity across the whole catalogue.",
  seed_confidence: 0.15,
  weights: [
    { node_id: "engineering", weight: 0.25 },
    { node_id: "comedy", weight: 0.25 },
    { node_id: "news", weight: 0.0 }
  ]
};

describe("resolveEffectiveTaxonomy — the three-tier fallback", () => {
  it("tier 3: with no user rows and no persona, returns the global taxonomy unchanged", () => {
    const result = resolveEffectiveTaxonomy(TAXONOMY, [], undefined);
    expect(result).toEqual(TAXONOMY.nodes);
  });

  it("tier 2: with a persona and no user rows, a top-level node takes the persona's weight/seed_confidence", () => {
    const result = resolveEffectiveTaxonomy(TAXONOMY, [], PERSONA);
    const engineering = result.find((n) => n.id === "engineering")!;
    expect(engineering.weight).toBe(0.25);
    expect(engineering.confidence).toBe(0.15);
  });

  it("tier 2: a nested node with no direct persona entry inherits its top-level ancestor's persona weight", () => {
    const result = resolveEffectiveTaxonomy(TAXONOMY, [], PERSONA);
    const fusion = result.find((n) => n.id === "engineering/energy-fusion")!;
    expect(fusion.weight).toBe(0.25); // inherited from "engineering", not the global 1.0
    expect(fusion.confidence).toBe(0.15);
  });

  it("tier 1: a real per-user row always wins over the persona, even for a node the persona also covers", () => {
    const userRows: UserTaxonomyRow[] = [{ nodeId: "engineering", weight: -0.4, confidence: 0.8, source: "manual-edit" }];
    const result = resolveEffectiveTaxonomy(TAXONOMY, userRows, PERSONA);
    const engineering = result.find((n) => n.id === "engineering")!;
    expect(engineering.weight).toBe(-0.4);
    expect(engineering.confidence).toBe(0.8);
  });

  it("tier 1: a real per-user row for a nested node wins over inheriting the persona's top-level weight", () => {
    const userRows: UserTaxonomyRow[] = [{ nodeId: "engineering/energy-fusion", weight: 0.9, confidence: 0.6, source: "inferred" }];
    const result = resolveEffectiveTaxonomy(TAXONOMY, userRows, PERSONA);
    const fusion = result.find((n) => n.id === "engineering/energy-fusion")!;
    expect(fusion.weight).toBe(0.9);
    expect(fusion.confidence).toBe(0.6);
  });

  it("a node absent from both the user's rows and the persona falls through to tier 3 (global)", () => {
    const personaMissingNews: Persona = { ...PERSONA, weights: PERSONA.weights.filter((w) => w.node_id !== "news") };
    const result = resolveEffectiveTaxonomy(TAXONOMY, [], personaMissingNews);
    const news = result.find((n) => n.id === "news")!;
    expect(news.weight).toBe(-0.8); // global taxonomy's own weight, untouched
  });

  it("preserves node metadata (label, apple_anchor, parent) from the global taxonomy regardless of tier", () => {
    const result = resolveEffectiveTaxonomy(TAXONOMY, [], PERSONA);
    const engineering = result.find((n) => n.id === "engineering")!;
    expect(engineering.label).toBe("Engineering");
    expect(engineering.apple_anchor).toBe("Science");
    expect(engineering.parent).toBeNull();
  });
});

describe("materializePersonaSeedRows", () => {
  it("produces one row per persona weight, tagged source: persona-seed at the persona's seed_confidence", () => {
    const rows = materializePersonaSeedRows(PERSONA);
    expect(rows).toHaveLength(PERSONA.weights.length);
    for (const row of rows) {
      expect(row.source).toBe("persona-seed");
      expect(row.confidence).toBe(PERSONA.seed_confidence);
    }
    expect(rows.find((r) => r.nodeId === "engineering")?.weight).toBe(0.25);
  });
});

describe("InMemoryUserInterestsProvider", () => {
  it("getPersonaSeed defaults to null for an unknown user (no implicit persona assumption)", async () => {
    const provider = new InMemoryUserInterestsProvider();
    expect(await provider.getPersonaSeed("nobody-set-this-user")).toBeNull();
  });

  it("getUserTaxonomyNodes defaults to an empty array for an unknown user", async () => {
    const provider = new InMemoryUserInterestsProvider();
    expect(await provider.getUserTaxonomyNodes("nobody-set-this-user")).toEqual([]);
  });

  it("getPersona resolves a real persona id from data/personas.json", async () => {
    const provider = new InMemoryUserInterestsProvider();
    const generalist = await provider.getPersona("generalist");
    expect(generalist?.id).toBe("generalist");
  });

  it("getPersona returns undefined for an unknown persona id", async () => {
    const provider = new InMemoryUserInterestsProvider();
    expect(await provider.getPersona("not-a-real-persona")).toBeUndefined();
  });

  it("seedFromPersona writes real rows for a user with none yet", async () => {
    const provider = new InMemoryUserInterestsProvider();
    provider.setPersonaSeed("new-user", "generalist");
    expect(await provider.getUserTaxonomyNodes("new-user")).toEqual([]);

    await provider.seedFromPersona("new-user", "generalist");

    const rows = await provider.getUserTaxonomyNodes("new-user");
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.source === "persona-seed")).toBe(true);
  });

  it("seedFromPersona is idempotent — never overwrites rows the user already has", async () => {
    const provider = new InMemoryUserInterestsProvider();
    provider.setUserTaxonomyNodes("existing-user", [
      { nodeId: "engineering", weight: 0.7, confidence: 0.9, source: "manual-edit" }
    ]);

    await provider.seedFromPersona("existing-user", "generalist");

    const rows = await provider.getUserTaxonomyNodes("existing-user");
    expect(rows).toEqual([{ nodeId: "engineering", weight: 0.7, confidence: 0.9, source: "manual-edit" }]);
  });

  it("seedFromPersona is a no-op for an unknown persona id", async () => {
    const provider = new InMemoryUserInterestsProvider();
    provider.setPersonaSeed("new-user", "not-a-real-persona");
    await provider.seedFromPersona("new-user", "not-a-real-persona");
    expect(await provider.getUserTaxonomyNodes("new-user")).toEqual([]);
  });
});

describe("createUserInterestsProvider", () => {
  it("returns an InMemoryUserInterestsProvider when DATABASE_URL is absent (repo .env is empty for this build)", () => {
    expect(env.databaseUrl).toBeUndefined();
    const provider = createUserInterestsProvider();
    expect(provider).toBeInstanceOf(InMemoryUserInterestsProvider);
  });

  it("throws a clear not-implemented error when DATABASE_URL is set (no PostgresUserInterestsProvider yet)", () => {
    const original = env.databaseUrl;
    env.databaseUrl = "postgres://example/not-real";
    try {
      expect(() => createUserInterestsProvider()).toThrow(/PostgresUserInterestsProvider does not exist yet/);
    } finally {
      env.databaseUrl = original;
    }
  });
});
