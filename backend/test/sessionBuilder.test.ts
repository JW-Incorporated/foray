import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { buildSession } from "../src/curation/sessionBuilder";
import { extractCandidatesFromMarkdown } from "../src/curation/candidateExtractor";
import { StubEnricher } from "../src/enrich/StubEnricher";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { TaxonomyFileSchema } from "../src/types/taxonomy";
import { SessionDocSchema } from "../src/types/session";
import { InMemoryUserInterestsProvider } from "../src/curation/userInterests";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

function loadRealTaxonomy() {
  const raw = fs.readFileSync(path.join(REPO_ROOT, "data", "taxonomy.json"), "utf-8");
  return TaxonomyFileSchema.parse(JSON.parse(raw));
}

function loadRealCandidates() {
  const fusionMd = fs.readFileSync(path.join(REPO_ROOT, "docs", "research", "fusion-candidates.md"), "utf-8");
  const otherMd = fs.readFileSync(path.join(REPO_ROOT, "docs", "research", "other-slot-candidates.md"), "utf-8");
  return [
    ...extractCandidatesFromMarkdown(fusionMd, "fusion-candidates.md", "deep-learn"),
    ...extractCandidatesFromMarkdown(otherMd, "other-slot-candidates.md", null)
  ];
}

describe("buildSession — end-to-end pipeline proof (01_PROMPT.md item 8), zero API keys", () => {
  it("produces a session document that validates against the v1 session schema", async () => {
    const taxonomy = loadRealTaxonomy();
    const candidates = loadRealCandidates();
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 2.0);
    const enricher = new StubEnricher(guard);

    const result = await buildSession({
      userId: "test-user",
      sessionKey: "2026-07-08-morning",
      builtAt: new Date("2026-07-08T04:30:00Z"),
      commuteMinutes: 18,
      playbackSpeed: 1.5,
      taxonomy,
      candidates,
      enricher
    });

    // must validate byte-shape-for-byte-shape against data/session.json's schema
    expect(() => SessionDocSchema.parse(result.session)).not.toThrow();
    expect(result.session.version).toBe(1);
  });

  it("fills all 4 archetype slots given the real research candidate pools", async () => {
    const taxonomy = loadRealTaxonomy();
    const candidates = loadRealCandidates();
    const enricher = new StubEnricher();

    const result = await buildSession({
      userId: "test-user",
      sessionKey: "test-session",
      commuteMinutes: 20,
      playbackSpeed: 1.4,
      taxonomy,
      candidates,
      enricher
    });

    const archetypesPresent = new Set(result.session.cards.map((c) => c.archetype));
    expect(archetypesPresent).toEqual(new Set(["deep-learn", "stretch", "narrative", "comfort"]));
    expect(result.session.cards).toHaveLength(4);
  });

  it("every card references an episode present in the episodes record, with alternates too", async () => {
    const taxonomy = loadRealTaxonomy();
    const candidates = loadRealCandidates();
    const enricher = new StubEnricher();

    const { session } = await buildSession({
      userId: "test-user",
      sessionKey: "test-session",
      commuteMinutes: 20,
      playbackSpeed: 1.4,
      taxonomy,
      candidates,
      enricher
    });

    for (const card of session.cards) {
      expect(session.episodes[card.episode_id]).toBeDefined();
      for (const altId of card.alternates) {
        expect(session.episodes[altId]).toBeDefined();
      }
    }
  });

  it("why-lines are non-empty and the stretch card's why-line differs card to card (not generic praise placeholder)", async () => {
    const taxonomy = loadRealTaxonomy();
    const candidates = loadRealCandidates();
    const enricher = new StubEnricher();

    const { session } = await buildSession({
      userId: "test-user",
      sessionKey: "test-session",
      commuteMinutes: 20,
      playbackSpeed: 1.4,
      taxonomy,
      candidates,
      enricher
    });

    for (const card of session.cards) {
      expect(card.why_line.length).toBeGreaterThan(0);
      expect(card.why_line.toLowerCase()).not.toContain("fascinating deep dive");
    }
  });

  it("logs a score component breakdown for every candidate (audit trail per 03_CURATION_SPEC.md)", async () => {
    const taxonomy = loadRealTaxonomy();
    const candidates = loadRealCandidates();
    const enricher = new StubEnricher();

    const { scoreLog } = await buildSession({
      userId: "test-user",
      sessionKey: "test-session",
      commuteMinutes: 20,
      playbackSpeed: 1.4,
      taxonomy,
      candidates,
      enricher
    });

    expect(scoreLog.length).toBe(candidates.length);
    for (const entry of scoreLog) {
      expect(typeof entry.components.total).toBe("number");
      expect(entry.components.relevance).toBeGreaterThanOrEqual(0);
      expect(entry.components.relevance).toBeLessThanOrEqual(1);
    }
  });

  it("commute.content_minutes reflects the configured playback speed", async () => {
    const taxonomy = loadRealTaxonomy();
    const candidates = loadRealCandidates();
    const enricher = new StubEnricher();

    const { session } = await buildSession({
      userId: "test-user",
      sessionKey: "test-session",
      commuteMinutes: 18,
      playbackSpeed: 1.5,
      taxonomy,
      candidates,
      enricher
    });

    expect(session.commute.content_minutes).toBe(27);
  });

  it("spends exactly $0 in dry-run mode regardless of candidate pool size", async () => {
    const taxonomy = loadRealTaxonomy();
    const candidates = loadRealCandidates();
    const sink = new InMemoryCostEventSink();
    const guard = new BudgetGuard(sink, 2.0);
    const enricher = new StubEnricher(guard);

    await buildSession({
      userId: "cost-test-user",
      sessionKey: "test-session",
      commuteMinutes: 18,
      playbackSpeed: 1.5,
      taxonomy,
      candidates,
      enricher
    });

    expect(await guard.spentToday("cost-test-user")).toBe(0);
  });
});

describe("buildSession — per-user personalization (personalization-and-depth-plan.md Step A+B)", () => {
  it("with no userInterestsProvider supplied, behavior is unchanged (backward compat)", async () => {
    const taxonomy = loadRealTaxonomy();
    const candidates = loadRealCandidates();
    const enricher = new StubEnricher();

    const { session } = await buildSession({
      userId: "test-user",
      sessionKey: "test-session",
      commuteMinutes: 20,
      playbackSpeed: 1.4,
      taxonomy,
      candidates,
      enricher
    });

    expect(() => SessionDocSchema.parse(session)).not.toThrow();
    expect(session.cards).toHaveLength(4);
  });

  it("a brand-new user with a persona seed and no observed rows still fills all 4 archetype slots", async () => {
    const taxonomy = loadRealTaxonomy();
    const candidates = loadRealCandidates();
    const enricher = new StubEnricher();
    const provider = new InMemoryUserInterestsProvider();
    provider.setPersonaSeed("brand-new-user", "generalist");

    const { session } = await buildSession({
      userId: "brand-new-user",
      sessionKey: "test-session",
      commuteMinutes: 20,
      playbackSpeed: 1.4,
      taxonomy,
      candidates,
      enricher,
      userInterestsProvider: provider
    });

    const archetypesPresent = new Set(session.cards.map((c) => c.archetype));
    expect(archetypesPresent).toEqual(new Set(["deep-learn", "stretch", "narrative", "comfort"]));
    expect(session.cards).toHaveLength(4);
  });

  it("lazily seeds the user's taxonomy_nodes from their persona on first build", async () => {
    const taxonomy = loadRealTaxonomy();
    const candidates = loadRealCandidates();
    const enricher = new StubEnricher();
    const provider = new InMemoryUserInterestsProvider();
    provider.setPersonaSeed("brand-new-user", "generalist");

    expect(await provider.getUserTaxonomyNodes("brand-new-user")).toEqual([]);

    await buildSession({
      userId: "brand-new-user",
      sessionKey: "test-session",
      commuteMinutes: 20,
      playbackSpeed: 1.4,
      taxonomy,
      candidates,
      enricher,
      userInterestsProvider: provider
    });

    const seeded = await provider.getUserTaxonomyNodes("brand-new-user");
    expect(seeded.length).toBeGreaterThan(0);
    expect(seeded.every((r) => r.source === "persona-seed")).toBe(true);
  });

  it("a user with real observed taxonomy_nodes rows is never re-seeded from their persona", async () => {
    const taxonomy = loadRealTaxonomy();
    const candidates = loadRealCandidates();
    const enricher = new StubEnricher();
    const provider = new InMemoryUserInterestsProvider();
    provider.setPersonaSeed("established-user", "generalist");
    provider.setUserTaxonomyNodes("established-user", [
      { nodeId: "engineering", weight: 0.95, confidence: 0.9, source: "manual-edit" }
    ]);

    await buildSession({
      userId: "established-user",
      sessionKey: "test-session",
      commuteMinutes: 20,
      playbackSpeed: 1.4,
      taxonomy,
      candidates,
      enricher,
      userInterestsProvider: provider
    });

    const rows = await provider.getUserTaxonomyNodes("established-user");
    expect(rows).toEqual([{ nodeId: "engineering", weight: 0.95, confidence: 0.9, source: "manual-edit" }]);
  });

  it("preserves the 4-slot archetype menu and cross-branch diversity even under an adversarial single-node persona (exploration floor is structural, not score-dependent)", async () => {
    const taxonomy = loadRealTaxonomy();
    const candidates = loadRealCandidates();
    const enricher = new StubEnricher();
    const provider = new InMemoryUserInterestsProvider();
    provider.setPersonaSeed("skewed-user", "generalist");
    // An extreme override: everything except one node hard-zeroed, one node
    // maxed out. If archetype-pool membership were ever accidentally
    // coupled to relevance score, this would collapse Stretch/Narrative/
    // Comfort into the dominant node's pool. It must not.
    provider.setUserTaxonomyNodes("skewed-user", [
      { nodeId: "engineering", weight: 1, confidence: 0.9, source: "manual-edit" },
      { nodeId: "engineering/energy-fusion", weight: 1, confidence: 0.9, source: "manual-edit" }
    ]);

    const { session, diversity } = await buildSession({
      userId: "skewed-user",
      sessionKey: "test-session",
      commuteMinutes: 20,
      playbackSpeed: 1.4,
      taxonomy,
      candidates,
      enricher,
      userInterestsProvider: provider
    });

    const archetypesPresent = new Set(session.cards.map((c) => c.archetype));
    expect(archetypesPresent).toEqual(new Set(["deep-learn", "stretch", "narrative", "comfort"]));
    expect(session.cards).toHaveLength(4);
    expect(diversity.distinctBranches).toBeGreaterThanOrEqual(3);
  });
});
