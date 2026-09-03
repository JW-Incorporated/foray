import { describe, it, expect } from "vitest";
import { matchConceptsInText, queryTapeAvailability, conceptLabel, type CatalogueData } from "../src/generation/catalogueLookup";

function fixtureCatalogue(): CatalogueData {
  return {
    items: [
      { id: "show-a--fusion-ep", show: "Show A", title: "Inside a Tokamak", topics: ["engineering/energy-fusion"], hook: "A deep look at fusion reactors." },
      { id: "show-a--fusion-ep-2", show: "Show A", title: "Stellarator Design", topics: ["engineering/energy-fusion"], hook: "Plasma confinement, explained." },
      { id: "show-b--bbq-ep", show: "Show B", title: "Texas Brisket", topics: ["food/cooking-science"], hook: "Smoking meat, the science of it." }
    ],
    itemTags: {
      "show-a--fusion-ep": ["fusion", "tokamak", "plasma"],
      "show-a--fusion-ep-2": ["fusion", "stellarator"],
      "show-b--bbq-ep": ["bbq", "brisket", "smoking"]
    },
    concepts: {
      fusion: { terms: ["fusion", "tokamak", "plasma", "stellarator"], topics: ["engineering/energy-fusion"], related: ["nuclear", "clean-energy"] },
      nuclear: { terms: ["nuclear", "fission", "reactor"], topics: ["engineering/energy-fusion"], related: ["fusion"] },
      "clean-energy": { terms: ["clean-energy", "renewable", "solar"], topics: ["engineering/energy-fusion"], related: ["fusion", "energy"] },
      bbq: { terms: ["bbq", "barbecue", "grilling", "brisket"], topics: ["food/cooking-science"], related: ["cooking"] }
    },
    shows: [
      { show_id: "show-a", title: "Show A", taxonomy_node_ids: ["engineering/energy-fusion"] },
      { show_id: "show-b", title: "Show B", taxonomy_node_ids: ["food/cooking-science"] }
    ]
  };
}

describe("matchConceptsInText — the semantic-index lookup §4.2's research map is built on", () => {
  it("matches a concept whose terms literally appear in the text", () => {
    const matches = matchConceptsInText("the history of fusion reactors", fixtureCatalogue().concepts);
    expect(matches).toContain("fusion");
  });

  it("matches a hyphenated concept term against a two-word phrase", () => {
    const matches = matchConceptsInText("clean energy policy", fixtureCatalogue().concepts);
    expect(matches).toContain("clean-energy");
  });

  it("returns no matches for text with no term overlap at all", () => {
    const matches = matchConceptsInText("the origin of onomatopoeia", fixtureCatalogue().concepts);
    expect(matches).toEqual([]);
  });

  it("ranks the concept with more matching terms first", () => {
    const matches = matchConceptsInText("fusion tokamak stellarator plasma reactor", fixtureCatalogue().concepts);
    expect(matches[0]).toBe("fusion");
  });
});

describe("queryTapeAvailability — accurate against real catalogue data, not hallucinated", () => {
  it("counts items and shows that actually match the given terms", () => {
    const result = queryTapeAvailability(["fusion", "tokamak", "plasma", "stellarator"], fixtureCatalogue());
    expect(result.itemCount).toBe(2);
    expect(result.showCount).toBe(1);
    expect(result.exampleItemIds).toEqual(["show-a--fusion-ep", "show-a--fusion-ep-2"]);
  });

  it("returns zero for a term genuinely absent from the catalogue — a real 'no tape' answer", () => {
    const result = queryTapeAvailability(["onomatopoeia"], fixtureCatalogue());
    expect(result.itemCount).toBe(0);
    expect(result.showCount).toBe(0);
    expect(result.exampleItemIds).toEqual([]);
  });

  it("matches against item-tags.json tags, not just title/hook text", () => {
    // "brisket" only appears in show-b's tags and hook, not its title.
    const result = queryTapeAvailability(["brisket"], fixtureCatalogue());
    expect(result.itemCount).toBe(1);
    expect(result.exampleItemIds).toEqual(["show-b--bbq-ep"]);
  });

  it("returns an empty result for an empty term list rather than matching everything", () => {
    const result = queryTapeAvailability([], fixtureCatalogue());
    expect(result.itemCount).toBe(0);
  });
});

describe("conceptLabel", () => {
  it("title-cases a hyphenated concept key into a readable label", () => {
    expect(conceptLabel("clean-energy")).toBe("Clean Energy");
    expect(conceptLabel("fusion")).toBe("Fusion");
  });
});
