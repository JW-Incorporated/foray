import { describe, it, expect } from "vitest";
import { matchConceptsInText, sharesTopicFamily, loadCatalogueData, type SemanticConcept } from "../src/generation/catalogueLookup";
import { buildResearchShape } from "../src/generation/researchShape";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { resolveTopic } from "../src/generation/resolveTopic";
import type { IntentUnderstanding } from "../src/types/generation";

/**
 * F-11: "The research map leaks off-topic concepts. The spine prompt for the
 * disasters Foray listed 'Ai (semantic-concept, tape: strong, 761 items)'
 * among eight candidate subtopics — the catalogue lookup matches on shared
 * tokens ('engineering') and the Practical AI corpus dominates the archive by
 * volume. Opus is told there is strong tape for AI on a bridge-collapse
 * documentary."
 *
 * Every test below runs against the REAL `data/semantic-index.json` and the
 * REAL `data/taxonomy.json`, with run 1's own prompt text, because the leak is
 * a property of that data and a fixture would let it come back.
 */

/* Run 1's intent, as §4.1 produced it (docs/curation/generation-run-2026-09-09.md
   §2, "Run 1 — engineering disasters"). */
const RUN_1_INTENT: IntentUnderstanding = {
  subject: "engineering disasters",
  angle: "the chains of small decisions behind collapsed bridges, failed dams and machines that broke",
  priorKnowledge: "knows the famous cases by name",
  disappointment: "a list of disasters with no mechanism"
};

const RUN_1_QUERY = `${RUN_1_INTENT.subject} ${RUN_1_INTENT.angle}`;

describe("F-11 — the Ai leak into an engineering-disasters research map", () => {
  const catalogue = loadCatalogueData();

  it("resolves run 1's intent to engineering/disasters", () => {
    /* The filter is keyed on this. If the taxonomy or the resolver ever stops
       placing run 1's own subject, the rest of this suite is testing nothing,
       so it is asserted rather than assumed. */
    expect(resolveTopic(RUN_1_QUERY).resolved).toBe("engineering/disasters");
  });

  it("no longer surfaces the `ai` concept", () => {
    const matched = matchConceptsInText(RUN_1_QUERY, catalogue.concepts, { topic: "engineering/disasters" });
    expect(matched).not.toContain("ai");
  });

  it("keeps every genuinely on-topic concept run 1 matched", () => {
    const matched = matchConceptsInText(RUN_1_QUERY, catalogue.concepts, { topic: "engineering/disasters" });
    /* These five are the ones a person would put in a bridge-collapse
       research map, and four of them are OUTSIDE the `engineering` root —
       `bridges` is architecture/infrastructure, `disasters` is
       aviation/accidents, `decision-making` is psychology/decision-making.
       A "same root segment" family rule would have deleted all of them and
       kept `ai`. See `sharesTopicFamily`. */
    for (const key of ["bridges", "engineering", "disasters", "infrastructure", "decision-making"]) {
      expect(matched).toContain(key);
    }
  });

  it("keeps an on-branch concept that matched only on a word stem", () => {
    const matched = matchConceptsInText(RUN_1_QUERY, catalogue.concepts, { topic: "engineering/disasters" });
    /* `engineering-failures` (topic engineering/disasters — the Foray's own
       node) matches run 1's prompt only through "collapse"/"collapsed". Its
       place is earned by the branch, which is exactly what the topic gate is
       for. */
    expect(matched).toContain("engineering-failures");
  });

  it("shows the leak was a two-letter substring, not a shared token", () => {
    /* "ai" is not a token of the prompt at all — `tokenize` drops words of two
       characters. The old matcher accepted any interior substring of the
       hyphen-joined query, and "chains" contains "ai". Proof that the term
       boundary rule closes it on its own, with no topic supplied. */
    expect(RUN_1_QUERY).toContain("chains");
    expect(matchConceptsInText(RUN_1_QUERY, catalogue.concepts)).not.toContain("ai");
  });

  it("still surfaces the ai concept for a Foray that is actually about it", () => {
    const matched = matchConceptsInText("how machine-learning systems get built", catalogue.concepts, {
      topic: "engineering/ai-robotics"
    });
    expect(matched).toContain("ai");
  });
});

describe("term matching at a word boundary", () => {
  const concepts: Record<string, SemanticConcept> = {
    ai: { terms: ["ai", "machine-learning"], topics: ["engineering/ai-robotics"], related: [] },
    energy: { terms: ["clean-energy"], topics: ["engineering/energy-grid"], related: [] },
    grilling: { terms: ["grill", "barbecue"], topics: ["food/grilling-bbq"], related: [] }
  };

  it("does not match a term inside an unrelated word", () => {
    expect(matchConceptsInText("chains of small decisions", concepts)).not.toContain("ai");
  });

  it("matches a multi-word term across adjacent words", () => {
    expect(matchConceptsInText("the clean energy transition", concepts)).toContain("energy");
  });

  it("matches a stem of four characters or more in either direction", () => {
    expect(matchConceptsInText("the history of grilling", concepts)).toContain("grilling");
    expect(matchConceptsInText("barbecues and smokers", concepts)).toContain("grilling");
  });

  it("matches an exact token", () => {
    expect(matchConceptsInText("a machine learning pipeline", concepts)).toContain("ai");
  });
});

describe("sharesTopicFamily — lineage, not root segment", () => {
  it("matches a node with itself and with its ancestors and descendants", () => {
    expect(sharesTopicFamily("engineering/disasters", "engineering/disasters")).toBe(true);
    expect(sharesTopicFamily("engineering/disasters", "engineering")).toBe(true);
    expect(sharesTopicFamily("engineering", "engineering/disasters")).toBe(true);
  });

  it("does NOT match two siblings under the same root", () => {
    /* The whole of F-11 in one assertion: `ai`'s only topic is
       engineering/ai-robotics, which shares a root with engineering/disasters
       and nothing else. */
    expect(sharesTopicFamily("engineering/ai-robotics", "engineering/disasters")).toBe(false);
  });

  it("is not fooled by a shared id prefix that is not a path segment", () => {
    expect(sharesTopicFamily("engineering", "engineering-adjacent/thing")).toBe(false);
  });

  it("is empty-safe", () => {
    expect(sharesTopicFamily("", "engineering")).toBe(false);
    expect(sharesTopicFamily("engineering", "  ")).toBe(false);
  });
});

describe("buildResearchShape resolves its own filter topic (F-11)", () => {
  it("keeps ai out of run 1's map without being told the topic", async () => {
    const shape = await buildResearchShape(RUN_1_INTENT, {
      researcher: new StubExternalResearcher(),
      ctx: { userId: "test-user" }
    });
    const labels = shape.subtopics.map((s) => s.label);
    expect(labels).not.toContain("Ai");
    expect(labels.length).toBeGreaterThan(0);
  });

  it("honours an explicitly pinned topic", async () => {
    const shape = await buildResearchShape(RUN_1_INTENT, {
      researcher: new StubExternalResearcher(),
      ctx: { userId: "test-user" },
      topic: "engineering/disasters"
    });
    expect(shape.subtopics.map((s) => s.label)).not.toContain("Ai");
  });

  it("still produces a map for a subject the taxonomy cannot place", async () => {
    /* §4.2's guardrail: "a genuinely untaped subject must still produce a real
       candidate, not an empty map." A topic-keyed filter must never be the
       thing that empties it. */
    const shape = await buildResearchShape(
      { ...RUN_1_INTENT, subject: "zzqqx", angle: "wwvvy" },
      { researcher: new StubExternalResearcher(), ctx: { userId: "test-user" }, topic: null }
    );
    expect(shape.subtopics.length).toBeGreaterThan(0);
  });
});
