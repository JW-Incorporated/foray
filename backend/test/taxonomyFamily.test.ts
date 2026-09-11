import { describe, it, expect, beforeEach } from "vitest";
import {
  familiesOfNodes,
  familyGateAllows,
  isOnTopic,
  nodesForArchiveEntry,
  nodesForPoolSegment,
  resetTaxonomyFamilyCache,
  taxonomyLineage,
  taxonomyNodesForItemId,
  taxonomyNodesForShowId,
  taxonomyRoot,
  unionNodes
} from "../src/generation/taxonomyFamily";
import { resetTaxonomyCache } from "../src/generation/resolveTopic";
import { deriveItemId } from "../src/generation/transcriptArchiveLookup";

/* §4.5's TOPIC GATE, unit-tested against the REAL committed catalogue files.
   Real rather than fixtures on purpose: the whole finding this module closes
   (F-29 — "the pool carries a `topic` field and the Foray has a resolved
   taxonomy node, and the scorer never compares them") is about two real files
   that were never joined, and a fixture taxonomy would let the join drift out
   of shape without a test noticing. The assertions below pin RELATIONSHIPS
   (`engineering/disasters` is a child of `engineering`; *Geology Bites* is not
   engineering), not counts, so an added node or show does not fail them. */

beforeEach(() => {
  resetTaxonomyFamilyCache();
  resetTaxonomyCache();
});

describe("taxonomyRoot / familiesOfNodes — the coarse label, kept only for WS-B's field", () => {
  it("takes the first path segment, and treats a root node as its own family", () => {
    expect(taxonomyRoot("engineering/disasters")).toBe("engineering");
    expect(taxonomyRoot("engineering")).toBe("engineering");
    expect(taxonomyRoot("  Food/Grilling-BBQ  ")).toBe("food");
  });

  it("is null for anything that is not a node id", () => {
    expect(taxonomyRoot(null)).toBeNull();
    expect(taxonomyRoot(undefined)).toBeNull();
    expect(taxonomyRoot("")).toBeNull();
    expect(taxonomyRoot("   ")).toBeNull();
    expect(taxonomyRoot("/")).toBeNull();
  });

  it("reduces a node list to its distinct roots — the values WS-B's `families` carries", () => {
    expect(familiesOfNodes(["engineering/disasters", "engineering", "food/food-history"])).toEqual(["engineering", "food"]);
    expect(familiesOfNodes([])).toEqual([]);
  });
});

describe("taxonomyLineage — a family is node + ancestors + descendants", () => {
  it("gives a leaf its own id and its parent, and NOT its siblings", () => {
    const lineage = taxonomyLineage("engineering/disasters");
    expect(lineage).toContain("engineering/disasters");
    expect(lineage).toContain("engineering");
    expect(lineage).not.toContain("engineering/precision-mfg");
    expect(lineage).not.toContain("engineering/energy-grid");
  });

  it("gives a root its children", () => {
    const lineage = taxonomyLineage("engineering");
    expect(lineage).toContain("engineering");
    expect(lineage).toContain("engineering/disasters");
    expect(lineage).toContain("engineering/precision-mfg");
    expect(lineage).not.toContain("food/food-history");
  });

  it("is symmetric: x is in y's family exactly when y is in x's", () => {
    /* The property the gate depends on — without it a broadly-classified show
       would reach a narrow Foray but not the reverse, and the gate's answer
       would depend on which side happened to be asked. */
    for (const [a, b] of [
      ["engineering", "engineering/disasters"],
      ["engineering/disasters", "engineering/disasters"],
      ["engineering/disasters", "engineering/precision-mfg"],
      ["engineering/disasters", "food/food-history"]
    ] as Array<[string, string]>) {
      expect(taxonomyLineage(a).includes(b)).toBe(taxonomyLineage(b).includes(a));
    }
  });

  it("is empty for an id the taxonomy does not have", () => {
    expect(taxonomyLineage("engineering/not-a-real-node")).toEqual([]);
    expect(taxonomyLineage("")).toEqual([]);
  });
});

describe("the catalogue joins the gate is built on", () => {
  it("resolves a curated show's nodes by show_id", () => {
    expect(taxonomyNodesForShowId("causality-engineered-network")).toContain("engineering/disasters");
    expect(taxonomyNodesForShowId("geology-bites")).toContain("nature/earth-science");
  });

  it("resolves an item id through data/segment-sources.json to its show's nodes", () => {
    /* The join WS-B's `computeTapeRelevance` uses, mirrored here so the gate
       and the metric judge one anchor the same way. */
    expect(taxonomyNodesForItemId("causality-engineered-network--47-hyatt-regency-kansas-city")).toContain("engineering/disasters");
    // The British Food History Podcast — run 1's `bfh-griddle-bakestone` anchor.
    expect(familiesOfNodes(taxonomyNodesForItemId("bfh-griddle-bakestone"))).not.toContain("engineering");
  });

  it("returns an empty list, never a throw, for an unknown show or item", () => {
    expect(taxonomyNodesForShowId("no-such-show-anywhere")).toEqual([]);
    expect(taxonomyNodesForItemId("no-such-item-anywhere")).toEqual([]);
    expect(taxonomyNodesForShowId("")).toEqual([]);
  });

  it("unions node lists without duplicating or reordering", () => {
    expect(unionNodes("engineering/disasters", ["engineering", "engineering/disasters"], null)).toEqual([
      "engineering/disasters",
      "engineering"
    ]);
    expect(unionNodes(undefined, [], null)).toEqual([]);
  });
});

describe("familyGateAllows / isOnTopic — inert without a topic, closed without a candidate", () => {
  it("refuses a sibling and allows the lineage", () => {
    expect(familyGateAllows("engineering/disasters", ["engineering/precision-mfg"])).toBe(false);
    expect(familyGateAllows("engineering/disasters", ["engineering"])).toBe(true);
    expect(familyGateAllows("engineering/disasters", ["engineering/disasters"])).toBe(true);
    expect(familyGateAllows("engineering", ["engineering/disasters"])).toBe(true);
    expect(familyGateAllows("engineering/disasters", ["food/food-history"])).toBe(false);
  });

  it("passes when ANY of a multi-classified show's nodes is in the family", () => {
    expect(familyGateAllows("engineering/disasters", ["nature/earth-science", "engineering/disasters"])).toBe(true);
  });

  it("is inert when the Foray has no resolved topic — exactly the pre-run-1 behaviour", () => {
    expect(familyGateAllows(null, [])).toBe(true);
    expect(familyGateAllows(null, ["food/food-history"])).toBe(true);
  });

  it("fails CLOSED when the candidate's subject cannot be established", () => {
    /* "I could not tell" is not evidence that the tape is on topic. This is
       the half of the asymmetry that keeps an unclassified show out of a real
       run, which always has a resolved topic. */
    expect(familyGateAllows("engineering/disasters", [])).toBe(false);
  });

  it("reports null — not false — for an anchor nothing could be judged about", () => {
    expect(isOnTopic(null, ["engineering/disasters"])).toBeNull();
    expect(isOnTopic("engineering/disasters", [])).toBeNull();
    expect(isOnTopic("engineering/disasters", ["engineering/disasters"])).toBe(true);
    expect(isOnTopic("engineering/disasters", ["food/food-history"])).toBe(false);
  });

  it("falls back to the coarse comparison when a node is outside the taxonomy", () => {
    /* Neither side can be looked up, so the only honest comparison left is the
       root string — less confident, but not "everything is off topic". */
    expect(familyGateAllows("engineering/not-a-real-node", ["engineering/disasters"])).toBe(true);
    expect(familyGateAllows("engineering/not-a-real-node", ["food/food-history"])).toBe(false);
    expect(familyGateAllows("engineering/disasters", ["engineering/not-a-real-node"])).toBe(true);
  });
});

describe("nodesForArchiveEntry / nodesForPoolSegment — the two unions the gates and F-91's supply measure share", () => {
  it("unions the show's nodes with the item-id join for an episode, and a segment's own topic with its show's for a pool row", () => {
    /* F-91 moved both unions here from private copies in sourceBeats.ts and
       researchShape.ts so the supply measure could not drift from the gates.
       Pinned on the REAL catalogue: the Hyatt Regency episode of *Causality*
       is classified `engineering/disasters` by its show while its pool
       segments carry `architecture/infrastructure` — the union has to carry
       both, or an engineering Foray refuses the right episode on a curator's
       per-segment nuance (sourceBeats.ts's own example). MUTATION THAT KILLS
       THIS: return the segment's `topic` alone. */
    const entry = {
      show_id: "causality-engineered-network",
      show_title: "Causality",
      guid: "hyatt",
      title: "47: Hyatt Regency, Kansas City",
      cues: 10
    };
    const byEntry = nodesForArchiveEntry(entry);
    expect(byEntry).toEqual(unionNodes(taxonomyNodesForShowId("causality-engineered-network"), taxonomyNodesForItemId(deriveItemId(entry))));
    expect(byEntry).toContain("engineering/disasters");

    const bySegment = nodesForPoolSegment({ item_id: "causality-engineered-network--47-hyatt-regency-kansas-city", topic: "architecture/infrastructure" });
    expect(bySegment[0]).toBe("architecture/infrastructure");
    expect(bySegment).toContain("engineering/disasters");
    /* A row with no resolvable show still carries its own node, and nothing else. */
    expect(nodesForPoolSegment({ item_id: "no-such-item", topic: "food/grilling-bbq" })).toEqual(["food/grilling-bbq"]);
    expect(nodesForArchiveEntry({ ...entry, show_id: "no-such-show", title: "nothing" })).toEqual([]);
  });
});
