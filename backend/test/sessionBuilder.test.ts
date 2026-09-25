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
import { BANNED, COMMUTE_FRAMING } from "../src/copy/rules";

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

  /* The gate on the GENERATOR, not only on data/session.json. F3.2 in
     docs/architecture-assessment.md: fitLine() once emitted "fits today's
     drive almost exactly" and "about N drives at your 1.5×", and copyRules
     only read the committed JSON, so a rebuild would have re-introduced the
     framing the JSON fix removed. Here every string on every built card and
     category is read against BANNED + COMMUTE_FRAMING, and fit_line is pinned
     to the plain duration statement.
     MUTATION: make fitLine() return `${durationMin} min: fits today's drive.`
     -> red, naming fit_line; label deep-learn "Deep dive" -> red, naming
     archetype_label. */
  it("emits no banned phrase or commute-length framing in any card or category string", async () => {
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

    const failures: string[] = [];
    let checked = 0;
    const check = (where: string, obj: Record<string, unknown>) => {
      for (const [field, text] of Object.entries(obj)) {
        if (typeof text !== "string") continue;
        checked += 1;
        for (const rx of [...BANNED, ...COMMUTE_FRAMING]) {
          if (rx.test(text)) failures.push(`${where} ${field}: ${rx} in "${text}"`);
        }
      }
    };
    for (const card of session.cards) {
      check(`slot ${card.slot}`, card);
      expect(card.fit_line, `slot ${card.slot} fit_line is not a plain duration statement`).toMatch(/^\d+ min \(≈ \d+ at 1\.5×\)\.$/);
    }
    for (const cat of session.categories) check(`category ${cat.id}`, cat);
    expect(checked, "no card copy was read, so this proved nothing").toBeGreaterThan(0);
    expect(failures, failures.join("\n")).toEqual([]);
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

/* Round-3 audit, lane L6: backend-rest-15 (the dedup log names the survivor)
   and backend-rest-16 (an unparseable date scores neutral, not as 1970). */
describe("buildSession round-3 fixes", () => {
  it("the dedup log names the candidate actually kept, never keptId === droppedId (backend-rest-15)", async () => {
    const candidates = loadRealCandidates();
    const base = candidates[0]!;
    const dupTitle = "Qzxv entirely unique duplicate title for the dedup log";
    // "b-dup" comes first, so it is the survivor; "a-dup" is the group's root (smallest id).
    const withDups = [...candidates, { ...base, id: "b-dup", title: dupTitle }, { ...base, id: "a-dup", title: dupTitle }];
    const { droppedDuplicates, scoreLog } = await buildSession({
      userId: "test-user",
      sessionKey: "dedup",
      commuteMinutes: 20,
      playbackSpeed: 1.4,
      taxonomy: loadRealTaxonomy(),
      candidates: withDups,
      enricher: new StubEnricher()
    });
    expect(droppedDuplicates).toContainEqual({ keptId: "b-dup", droppedId: "a-dup" });
    for (const d of droppedDuplicates) expect(d.keptId).not.toBe(d.droppedId);
    expect(scoreLog.some((e) => e.candidateId === "b-dup")).toBe(true);
    expect(scoreLog.some((e) => e.candidateId === "a-dup")).toBe(false);
  });

  it("an unparseable release date gets the neutral freshness 0.5, not 1970's 0 (backend-rest-16)", async () => {
    const candidates = loadRealCandidates();
    const undated = { ...candidates[0]!, id: "undated-1", title: "Qzxv undated candidate", releaseDate: "unknown" };
    const { scoreLog } = await buildSession({
      userId: "test-user",
      sessionKey: "undated",
      commuteMinutes: 20,
      playbackSpeed: 1.4,
      taxonomy: loadRealTaxonomy(),
      candidates: [...candidates, undated],
      enricher: new StubEnricher()
    });
    const entry = scoreLog.find((e) => e.candidateId === "undated-1")!;
    expect(entry.components.freshness).toBe(0.5);
  });
});
