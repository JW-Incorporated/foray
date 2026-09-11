import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  resolveTopic,
  scoreTopics,
  loadTaxonomyNodes,
  GENERIC_LABEL_WORDS,
  type TaxonomyNode
} from "../src/generation/resolveTopic";

/**
 * F-59 — "the topic resolver's fusion magnet"
 * (docs/curation/generation-run-2026-09-09.md).
 *
 * Generation run 2's topic text resolved to `engineering/energy-fusion`, so
 * §4.5's lineage gate refused every AI-adjacent show in the archive and
 * sourcing found no tape at all (attempt 2's per-slot summaries are all
 * `tier2:lineage`). Nothing in that prompt was about fusion: the node won on
 * `engineering` — free to all six of that root's children — plus `systems`,
 * from the label "Fusion & energy systems". The same node is the magnet in
 * issue #547, where CBC Ideas, Lex Fridman and Catalyst are all classified to
 * it and nothing else.
 *
 * These run against the REAL `data/taxonomy.json` and the REAL
 * `data/semantic-index.json`, with run 2's own text, because the failure is a
 * property of that data and a fixture would let it come back.
 */

/* Run 2's topic text, composed exactly as `runPipeline.ts` composes it:
   `[intent.subject, intent.angle, spine.acts.map(a => a.title).join(" ")]`.
   Subject, angle and act titles are lifted from the run's own checkpoint via
   the fixture `sourceBeats.test.ts` already replays. */
const RUN_2 = JSON.parse(
  readFileSync(join(__dirname, "fixtures", "run2-deepen-2026-09-09.json"), "utf8")
) as { subject: string; angle: string; acts: Array<{ title: string }> };

const RUN_2_TOPIC_TEXT = [RUN_2.subject, RUN_2.angle, RUN_2.acts.map((a) => a.title).join(" ")].join(" ");

/* Run 1's, from `researchTopicFilter.test.ts` — the resolution the fix must not
   move. Run 1 sourced real (if wrongly anchored) tape against
   `engineering/disasters`, and every WS-C gate downstream is keyed on it. */
const RUN_1_TOPIC_TEXT =
  "engineering disasters the chains of small decisions behind collapsed bridges, failed dams and machines that broke";

describe("resolveTopic — F-59, the energy-fusion magnet", () => {
  it("run 2's AI/ML topic text no longer resolves to engineering/energy-fusion", () => {
    const result = resolveTopic(RUN_2_TOPIC_TEXT);
    expect(result.resolved).not.toBe("engineering/energy-fusion");
  });

  it("run 2's topic text resolves to the AI/ML node instead", () => {
    /* `engineering/ai-robotics` is where the archive's AI tape is classified
       (`ai` in data/semantic-index.json names it and nothing else), so it is
       the node whose lineage gate lets a Practical AI episode through. */
    expect(resolveTopic(RUN_2_TOPIC_TEXT).resolved).toBe("engineering/ai-robotics");
  });

  it("energy-fusion does not even make run 2's shortlist any more", () => {
    const { candidates } = resolveTopic(RUN_2_TOPIC_TEXT);
    expect(candidates.map((c) => c.id)).not.toContain("engineering/energy-fusion");
  });

  it("names why it won: the phrase, not the two generic words", () => {
    const { candidates } = resolveTopic(RUN_2_TOPIC_TEXT);
    const winner = candidates[0]!;
    expect(winner.id).toBe("engineering/ai-robotics");
    expect(winner.matchedTerms).toContain("machine-learning");
    /* Its only shared token IS "engineering" — generic, and worth 0.25. The
       win comes entirely from the advertised phrase. */
    expect(winner.distinctiveTokens).toEqual([]);
  });

  it("scores energy-fusion on run 2's text with no distinctive evidence at all", () => {
    /* The mechanism, pinned directly: the node still MATCHES (two tokens,
       exactly as before), it simply cannot resolve on them. */
    const nodes = loadTaxonomyNodes();
    const fusion = scoreTopics(RUN_2_TOPIC_TEXT, nodes).find((c) => c.id === "engineering/energy-fusion")!;
    expect(fusion.matchedTokens.sort()).toEqual(["engineering", "systems"]);
    expect(fusion.distinctiveTokens).toEqual([]);
    expect(fusion.matchedTerms).toEqual([]);
  });

  it("still resolves a genuinely fusion topic — the node needs a fusion word", () => {
    const result = resolveTopic(
      "the long road to fusion power: tokamaks, plasma confinement and what ITER has to prove"
    );
    expect(result.resolved).toBe("engineering/energy-fusion");
    /* Word-boundary matching, no stems — "tokamaks" is not "tokamak". The
       resolver's bar is deliberately stricter than the research map's, whose
       stem rule is what let "ch-ai-ns" match the `ai` concept (F-11). */
    expect(result.candidates[0]!.matchedTerms).toEqual(["fusion", "iter", "plasma"]);
  });

  it("keeps run 1's engineering-disasters prompt on engineering/disasters", () => {
    /* The other half of the regression: F-59's fix must not move the run whose
       sourcing gates are already pinned (researchTopicFilter.test.ts, WS-C). */
    expect(resolveTopic(RUN_1_TOPIC_TEXT).resolved).toBe("engineering/disasters");
  });

  it("keeps the two resolutions the module's own header promises", () => {
    expect(resolveTopic("the history of grilling").resolved).toBe("food/grilling-bbq");
    expect(resolveTopic("roman concrete and how it survived two thousand years").resolved).toBeNull();
  });
});

describe("resolveTopic — generic words rank, distinctive words resolve", () => {
  /* The real `engineering` subtree, because genericity is measured against the
     tree it is in: a root word shared by six nodes is generic, and a fixture
     with two children would make "engineering" look distinctive and test
     nothing. */
  const NODES: TaxonomyNode[] = [
    { id: "engineering", parent: null, label: "Engineering" },
    {
      id: "engineering/energy-fusion",
      parent: "engineering",
      label: "Fusion & energy systems",
      terms: ["fusion", "tokamak", "plasma"]
    },
    { id: "engineering/disasters", parent: "engineering", label: "Disasters" },
    { id: "engineering/ai-robotics", parent: "engineering", label: "Ai Robotics" },
    { id: "engineering/energy-grid", parent: "engineering", label: "Energy Grid" },
    { id: "engineering/precision-mfg", parent: "engineering", label: "Precision manufacturing" }
  ];

  it("refuses a node whose whole case is generic words", () => {
    const result = resolveTopic("engineering systems in production", { nodes: NODES, terms: new Map() });
    expect(result.resolved).toBeNull();
    /* It is still REPORTED, with the words it matched — the diagnostics F-59
       needed a replay to recover. */
    expect(result.candidates[0]!.id).toBe("engineering/energy-fusion");
    expect(result.candidates[0]!.matchedTokens.sort()).toEqual(["engineering", "systems"]);
  });

  it("resolves the same node once a fusion term appears", () => {
    const result = resolveTopic("engineering systems for plasma confinement", { nodes: NODES });
    expect(result.resolved).toBe("engineering/energy-fusion");
    expect(result.candidates[0]!.matchedTerms).toEqual(["plasma"]);
  });

  it("resolves on one distinctive token, as it always did", () => {
    const result = resolveTopic("what causes engineering disasters", { nodes: NODES });
    expect(result.resolved).toBe("engineering/disasters");
    /* "engineering" is carried by six of these nodes, so it is generic here
       exactly as it is in the real tree; "disasters" is the only word that
       picks one. */
    expect(result.candidates[0]!.distinctiveTokens).toEqual(["disasters"]);
    expect(result.candidates[0]!.matchedTokens).toEqual(["disasters", "engineering"]);
  });

  it("a generic token is worth a quarter of a distinctive one", () => {
    const [best] = scoreTopics("engineering disasters", NODES, new Map());
    /* disasters (1) + engineering (0.25) + child (0.5) */
    expect(best!.id).toBe("engineering/disasters");
    expect(best!.score).toBe(1.75);
  });

  it("lists `systems` as a form-word and NOT the words that name real nodes", () => {
    expect(GENERIC_LABEL_WORDS.has("systems")).toBe(true);
    for (const word of ["technology", "management", "design", "history", "science", "energy"]) {
      expect(GENERIC_LABEL_WORDS.has(word), `"${word}" names a real node's subject`).toBe(false);
    }
  });

  it("returns at most five candidates, ranked, on both paths", () => {
    const resolved = resolveTopic(RUN_2_TOPIC_TEXT);
    const unresolved = resolveTopic("engineering systems in production", { nodes: NODES, terms: new Map() });
    for (const result of [resolved, unresolved]) {
      expect(result.candidates.length).toBeGreaterThan(0);
      expect(result.candidates.length).toBeLessThanOrEqual(5);
      const scores = result.candidates.map((c) => c.score);
      expect([...scores].sort((a, b) => b - a)).toEqual(scores);
    }
    expect(resolved.resolved).not.toBeNull();
    expect(unresolved.resolved).toBeNull();
  });
});

describe("resolveTopic — F-67, the AI node advertises its own vocabulary", () => {
  it("places run 2 attempt 4's 8-word subject under engineering/ai-robotics once the prompt joins the text", () => {
    /* The understander's paraphrase said "ML"; the prompt said "machine
       learning" and "AI systems". Subject + angle alone resolved to
       architecture/infrastructure (the word "infrastructure", nothing else),
       and the lineage gate refused every AI episode. MUTATION THAT KILLS
       THIS: remove `terms` from engineering/ai-robotics in data/taxonomy.json
       AND drop the prompt from the text — the resolver falls back to
       "infrastructure". */
    const prompt =
      "How AI systems really get built and put to work: the practical engineering behind deploying machine learning, from data to production";
    const subject = "Real-world ML production: infrastructure, data, and operational challenges";
    const angle =
      "Production ML is primarily systems engineering, not algorithm research — the hard parts are data pipelines, model serving, monitoring, and debugging failures at scale";
    expect(resolveTopic(`${prompt} ${subject} ${angle}`).resolved).toBe("engineering/ai-robotics");
  });

  it("resolves the abbreviation on its own: 'ML' and 'MLOps' are the AI node's terms", () => {
    const r = resolveTopic("Real-world ML production: what MLOps teams actually do");
    expect(r.resolved).toBe("engineering/ai-robotics");
  });
});
