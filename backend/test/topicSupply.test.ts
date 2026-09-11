import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { resolveTopic, resetTaxonomyCache, type ResolveTopicResult, type TopicCandidate } from "../src/generation/resolveTopic";
import { resetTaxonomyFamilyCache, taxonomyRoot } from "../src/generation/taxonomyFamily";
import {
  MIN_TOPIC_SUPPLY,
  TOPIC_SUPPLY_SCORE_FLOOR,
  chooseTopic,
  consideredTopicIds,
  measureTopicSupply,
  noSupplyReason,
  pinnedTopicDecision,
  topicDecisionLine,
  type TopicSupplyMap
} from "../src/generation/topicSupply";
import type { TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";

/**
 * F-91 — "supply-aware topic resolution"
 * (docs/curation/generation-run-2026-09-09.md).
 *
 * Generation run 8 (2026-09-11): "What engineers actually do all day: how
 * engineering careers really work…" resolved to `business/careers` on the one
 * token "careers" (1.5) over four engineering children at 0.75 each. §4.5's
 * lineage gate then refused every episode of *Being an Engineer* — 334
 * indexed, the only show in the archive about the subject — because that show
 * carries `engineering` nodes and `business/careers`'s family has none. All 29
 * beats: `tier2:text-index:no-candidate`; NO TAPE after an Opus spine call and
 * four Sonnet deepen calls. "The history of India…" collapses the same way via
 * `cities/urbanism`.
 *
 * The fix measures how much tape each candidate's family admits — through the
 * SAME gate predicates §4.5 applies — and lets supply break a tie the word
 * scorer could not, within a score floor; with no supply anywhere the run
 * stops before the spine. These tests pin the count, the choice, its bounds,
 * and the two run-8 prompts as regressions against the REAL taxonomy and
 * semantic index (a fixture taxonomy would let the lottery come back), with a
 * fixture catalogue so the show classifications are the ones run 8 saw.
 *
 * MUTATIONS EACH TEST KILLS are named inline. The headline ones: a root-
 * segment comparison in place of the lineage gate (`disasters` would count
 * `ai-robotics` tape); dropping the pool from `usable`; `>` for `>=` on
 * `MIN_TOPIC_SUPPLY`; a floor of 0.4 instead of 0.5; deleting the root
 * stand-in; promoting a candidate on an unresolved result.
 */

const REAL_DATA = join(__dirname, "..", "..", "data");

/* Run 8's prompt, verbatim from the batch file. */
const RUN_8_PROMPT =
  "What engineers actually do all day: how engineering careers really work, from the first job and the first failure to leading a team, told by working engineers";
/* The India prompt's shape — the token that does the damage is "cities". */
const INDIA_PROMPT = "The history of India: from the Indus Valley cities to independence, told by historians";

/* `taxonomyNodesForShowId("being-an-engineer")` as run 8's machine reported it. */
const BEING_AN_ENGINEER_RUN_8 = [
  "engineering",
  "engineering/energy-fusion",
  "engineering/precision-mfg",
  "engineering/disasters",
  "engineering/energy-grid",
  "engineering/ai-robotics"
];
/* …and as `data/catalog.json` on main classifies it. */
const BEING_AN_ENGINEER_MAIN = ["engineering/precision-mfg", "craft/diy-home"];

interface FixtureShow {
  show_id: string;
  title: string;
  taxonomy_node_ids: string[];
}

const roots: string[] = [];

/** The real taxonomy and semantic index, with a catalogue of exactly these shows. */
function fixtureRoot(shows: FixtureShow[]): string {
  const root = mkdtempSync(join(tmpdir(), "f91-topic-supply-"));
  mkdirSync(join(root, "data"));
  copyFileSync(join(REAL_DATA, "taxonomy.json"), join(root, "data", "taxonomy.json"));
  copyFileSync(join(REAL_DATA, "semantic-index.json"), join(root, "data", "semantic-index.json"));
  writeFileSync(join(root, "data", "catalog.json"), JSON.stringify({ shows }));
  roots.push(root);
  return root;
}

function show(show_id: string, taxonomy_node_ids: string[]): FixtureShow {
  return { show_id, title: show_id, taxonomy_node_ids };
}

function episodes(showId: string, n: number): TranscriptDigestEntry[] {
  return Array.from({ length: n }, (_, i) => ({
    show_id: showId,
    show_title: showId,
    guid: `${showId}-${i + 1}`,
    title: `${showId} episode ${i + 1}`,
    cues: 100
  }));
}

/** A resolver candidate with distinctive evidence, unless `generic` says its
 * whole case is one generic token (`token`, "engineering" by default). */
function candidate(id: string, score: number, opts: { generic?: boolean; token?: string } = {}): TopicCandidate {
  return {
    id,
    label: id,
    score,
    matchedTokens: opts.generic ? [opts.token ?? "engineering"] : ["word"],
    distinctiveTokens: opts.generic ? [] : ["word"],
    matchedTerms: []
  };
}

function resolvedAs(candidates: TopicCandidate[], resolved: string | null = candidates[0]?.id ?? null): ResolveTopicResult {
  return { resolved, candidates };
}

function supplyOf(counts: Array<[string, number]>): TopicSupplyMap {
  return new Map(counts.map(([id, usable]) => [id, { id, usable, archive: usable, pool: 0, byShow: {} }]));
}

beforeEach(() => {
  resetTaxonomyCache();
  resetTaxonomyFamilyCache();
});

afterEach(() => {
  resetTaxonomyCache();
  resetTaxonomyFamilyCache();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("measureTopicSupply — the tape each candidate's family admits, counted through §4.5's own gates", () => {
  it("counts archive entries per candidate and per show, through the LINEAGE gate, not the root segment", () => {
    /* MUTATION THAT KILLS THIS: compare `taxonomyRoot(candidate) ===
       taxonomyRoot(node)` instead of `familyGateAllows` — `engineering/disasters`
       would then count the ai-robotics show's five episodes. */
    const root = fixtureRoot([show("ai-show", ["engineering/ai-robotics"]), show("grill-show", ["food/grilling-bbq"])]);
    const archive = [...episodes("ai-show", 5), ...episodes("grill-show", 4)];
    const supply = measureTopicSupply(
      ["engineering", "engineering/ai-robotics", "engineering/disasters", "food/grilling-bbq", "business/careers"],
      { archive, root }
    );
    expect(supply.get("engineering")?.usable).toBe(5);
    expect(supply.get("engineering")?.byShow).toEqual({ "ai-show": 5 });
    expect(supply.get("engineering/ai-robotics")?.usable).toBe(5);
    expect(supply.get("engineering/disasters")?.usable).toBe(0);
    expect(supply.get("food/grilling-bbq")?.usable).toBe(4);
    expect(supply.get("business/careers")?.usable).toBe(0);
  });

  it("narrows the archive to searchable entries when asked, and counts the curated pool whatever the bodies say", () => {
    /* MUTATION THAT KILLS THIS: `usable: archive` (drop the pool) — the
       grilling fixtures in runPipeline.test.ts get their tape from the pool
       and would all stop `no-supply`. Also: apply `isSearchable` to the pool. */
    const root = fixtureRoot([show("grill-show", ["food/grilling-bbq"])]);
    const archive = episodes("grill-show", 5);
    const segmentPool = [
      { item_id: "grill-show--ep-1", topic: "food/grilling-bbq" },
      { item_id: "grill-show--ep-2", topic: "food/grilling-bbq" },
      { item_id: "quake-show--ep-9", topic: "nature/earth-science" }
    ];
    const supply = measureTopicSupply(["food/grilling-bbq", "nature/earth-science"], {
      archive,
      segmentPool,
      root,
      isSearchable: (entry) => entry.guid.endsWith("1") || entry.guid.endsWith("2")
    });
    expect(supply.get("food/grilling-bbq")).toMatchObject({ archive: 2, pool: 2, usable: 4 });
    expect(supply.get("nature/earth-science")).toMatchObject({ archive: 0, pool: 1, usable: 1 });
  });

  it("accepts candidate objects as well as ids, and returns nothing for nothing", () => {
    const root = fixtureRoot([show("ai-show", ["engineering/ai-robotics"])]);
    const supply = measureTopicSupply([candidate("engineering/ai-robotics", 1)], { archive: episodes("ai-show", 2), root });
    expect(supply.get("engineering/ai-robotics")?.usable).toBe(2);
    expect(measureTopicSupply([], { archive: episodes("ai-show", 2), root }).size).toBe(0);
  });
});

describe("chooseTopic — supply breaks the tie the word scorer could not, within its bounds", () => {
  it("keeps the best-scoring candidate when it already has supply", () => {
    /* MUTATION THAT KILLS THIS: always take the candidate with the most
       supply — `b` (300) would displace a resolution the archive can carry. */
    const result = resolvedAs([candidate("a", 1.5), candidate("b", 1.0)]);
    const decision = chooseTopic(result, supplyOf([["a", MIN_TOPIC_SUPPLY], ["b", 300]]));
    expect(decision).toMatchObject({ topic: "a", resolved: "a", reason: "best" });
    expect(decision.considered.map((c) => [c.id, c.supply])).toEqual([["a", MIN_TOPIC_SUPPLY], ["b", 300]]);
  });

  it("moves to the HIGHEST-SCORING candidate with supply when the best has none — score before supply", () => {
    /* MUTATION THAT KILLS THIS: sort the eligible set by supply first —
       `lower` (500) would beat `low` (300) despite the lower score. */
    const result = resolvedAs([candidate("best", 1.5), candidate("mid", 1.0), candidate("low", 0.8), candidate("lower", 0.76)]);
    const decision = chooseTopic(result, supplyOf([["best", 0], ["mid", 0], ["low", 300], ["lower", 500]]));
    expect(decision).toMatchObject({ topic: "low", resolved: "best", reason: "supply-aware" });
    expect(decision.considered.find((c) => c.id === "low")?.supply).toBe(300);
  });

  it("does not consider a well-stocked candidate scoring below TOPIC_SUPPLY_SCORE_FLOOR × best", () => {
    /* MUTATION THAT KILLS THIS: a floor of 0.4 — `other` at 0.9 of a 2.0 best
       clears 0.8 and gets picked; the pinned value is 0.5. */
    expect(TOPIC_SUPPLY_SCORE_FLOOR).toBe(0.5);
    const result = resolvedAs([candidate("best", 2.0), candidate("other", 0.9)]);
    const decision = chooseTopic(result, supplyOf([["best", 0], ["other", 300]]));
    expect(decision).toMatchObject({ topic: "best", reason: "no-supply" });
    /* Exactly at the floor is in. */
    const atFloor = chooseTopic(resolvedAs([candidate("best", 2.0), candidate("other", 1.0)]), supplyOf([["best", 0], ["other", 300]]));
    expect(atFloor).toMatchObject({ topic: "other", reason: "supply-aware" });
  });

  it("treats supply below MIN_TOPIC_SUPPLY as no supply, and exactly MIN_TOPIC_SUPPLY as supply", () => {
    /* MUTATION THAT KILLS THIS: `>` for `>=` — a best with exactly the minimum
       would be moved off; `MIN_TOPIC_SUPPLY - 1` guards the other direction. */
    expect(MIN_TOPIC_SUPPLY).toBe(3);
    const result = resolvedAs([candidate("best", 1.5), candidate("other", 1.0)]);
    expect(chooseTopic(result, supplyOf([["best", MIN_TOPIC_SUPPLY - 1], ["other", MIN_TOPIC_SUPPLY]]))).toMatchObject({
      topic: "other",
      reason: "supply-aware"
    });
    expect(chooseTopic(result, supplyOf([["best", MIN_TOPIC_SUPPLY], ["other", 300]]))).toMatchObject({ topic: "best", reason: "best" });
    expect(chooseTopic(result, supplyOf([["best", 0], ["other", MIN_TOPIC_SUPPLY - 1]]))).toMatchObject({ topic: "best", reason: "no-supply" });
  });

  it("breaks a score tie on supply, then on id", () => {
    /* MUTATION THAT KILLS THIS: drop the supply clause from the sort — `a`
       (10) would win the first case on id alone. */
    const tie = resolvedAs([candidate("best", 1.5), candidate("a", 1.0), candidate("b", 1.0)]);
    expect(chooseTopic(tie, supplyOf([["best", 0], ["a", 10], ["b", 50]])).topic).toBe("b");
    expect(chooseTopic(tie, supplyOf([["best", 0], ["a", 50], ["b", 50]])).topic).toBe("a");
  });

  it("returns the best with `no-supply` when nothing considered has supply, and the reason names every count", () => {
    /* MUTATION THAT KILLS THIS: return `topic: null` on no-supply — the
       outcome would read as unresolved and the report would lose the node the
       resolver actually picked. */
    const result = resolvedAs([candidate("best", 1.5), candidate("other", 1.0)]);
    const decision = chooseTopic(result, supplyOf([["best", 0], ["other", 0]]));
    expect(decision).toMatchObject({ topic: "best", resolved: "best", reason: "no-supply", minSupply: MIN_TOPIC_SUPPLY });
    const reason = noSupplyReason(decision, "archive");
    expect(reason).toMatch(/^NO SUPPLY: no transcript in the archive is in any candidate topic's family/);
    expect(reason).toContain("best=0");
    expect(reason).toContain("other=0");
    expect(noSupplyReason(decision, "bodies")).toContain("no transcript with a body on this machine");
  });

  it("never promotes a candidate the resolver did not resolve — `unresolved` stays unresolved", () => {
    /* MUTATION THAT KILLS THIS: fall through to the supply-aware pick when
       `resolved` is null — `resolveTopic`'s whole design is "fail rather than
       guess", and a well-stocked near-miss is still a guess. */
    const result = resolvedAs([candidate("near", 0.5), candidate("miss", 0.25)], null);
    const decision = chooseTopic(result, supplyOf([["near", 500], ["miss", 500]]));
    expect(decision).toMatchObject({ topic: null, resolved: null, reason: "unresolved" });
    expect(decision.considered.map((c) => c.id)).toEqual(["near", "miss"]);
  });

  it("counts a supply the caller did not measure as zero (fails closed)", () => {
    const result = resolvedAs([candidate("best", 1.5), candidate("other", 1.0)]);
    expect(chooseTopic(result, new Map())).toMatchObject({ topic: "best", reason: "no-supply" });
  });
});

describe("the root stand-in — a candidate whose whole case is a generic token is evidence for its root", () => {
  it("adds the root at the child's score, marked with the child it stands in for; a distinctive child adds nothing", () => {
    /* MUTATION THAT KILLS THIS: delete `weighCandidates`'s stand-in loop —
       `engineering` never enters `considered` and `consideredTopicIds` omits it. */
    const result = resolvedAs([candidate("food/grilling-bbq", 1.5), candidate("engineering/ai-robotics", 0.75, { generic: true })]);
    const ids = consideredTopicIds(result);
    expect(ids).toEqual(["food/grilling-bbq", "engineering", "engineering/ai-robotics"]);
    expect(ids).not.toContain("food");
    const decision = chooseTopic(result, supplyOf([["food/grilling-bbq", 0], ["engineering", 40], ["engineering/ai-robotics", 0]]));
    expect(decision).toMatchObject({ topic: "engineering", reason: "supply-aware" });
    expect(decision.considered.find((c) => c.id === "engineering")).toMatchObject({ score: 0.75, standInFor: "engineering/ai-robotics", eligible: true });
  });

  it("the stand-in is the root the generic WORD names, never the generic child's own root — and the child itself is never picked", () => {
    /* "The history of India": `food/food-history` matched "history" and
       nothing else. That word names `history`; `food`'s family is cider and
       barbecue. MUTATION THAT KILLS THIS: `taxonomyRoot(c.id)` in place of the
       token lookup (picks `food`), or dropping the `eligible` filter (picks
       `food/food-history` on its 14 pool segments). Both were the probe's
       actual output before the rule was tightened. */
    const result = resolvedAs([candidate("cities/urbanism", 1.5), candidate("food/food-history", 0.75, { generic: true, token: "history" })]);
    const ids = consideredTopicIds(result);
    expect(ids).toEqual(["cities/urbanism", "food/food-history", "history"]);
    expect(ids).not.toContain("food");
    const nothingInHistory = chooseTopic(result, supplyOf([["cities/urbanism", 2], ["food/food-history", 14], ["food", 87], ["history", 0]]));
    expect(nothingInHistory).toMatchObject({ topic: "cities/urbanism", reason: "no-supply" });
    expect(nothingInHistory.considered.find((c) => c.id === "food/food-history")).toMatchObject({ eligible: false, supply: 14 });
    const historyTape = chooseTopic(result, supplyOf([["cities/urbanism", 2], ["food/food-history", 14], ["history", 30]]));
    expect(historyTape).toMatchObject({ topic: "history", reason: "supply-aware" });
    expect(historyTape.considered.find((c) => c.id === "history")).toMatchObject({ standInFor: "food/food-history", eligible: true });
    /* A generic word that names no root adds nothing. */
    expect(consideredTopicIds(resolvedAs([candidate("a", 1.5), candidate("x/y", 0.75, { generic: true, token: "systems" })]))).toEqual(["a", "x/y"]);
  });

  it("lifts a root already on the shortlist to the generic child's score rather than listing it twice", () => {
    const result = resolvedAs([
      candidate("cities/urbanism", 1.5),
      candidate("engineering/ai-robotics", 0.75, { generic: true }),
      { ...candidate("engineering", 0.25, { generic: true }), id: "engineering" }
    ]);
    const ids = consideredTopicIds(result);
    expect(ids.filter((id) => id === "engineering")).toHaveLength(1);
    const decision = chooseTopic(result, supplyOf([["cities/urbanism", 0], ["engineering", 40], ["engineering/ai-robotics", 0]]));
    expect(decision.considered.find((c) => c.id === "engineering")).toMatchObject({ score: 0.75, standInFor: "engineering/ai-robotics" });
    expect(decision.topic).toBe("engineering");
  });

  it("consideredTopicIds always includes the resolved node, once", () => {
    const result = resolvedAs([candidate("a", 1.5), candidate("b", 1.0)], "b");
    expect(consideredTopicIds(result)).toEqual(["a", "b"]);
  });
});

describe("saying it — the run-log line and the pinned record", () => {
  it("the supply-aware line names the move, the two counts and every candidate", () => {
    /* The exact line F-91's brief asked for, as a person will read it in a run
       log. MUTATION THAT KILLS THIS: swap the two counts. */
    const result = resolvedAs([candidate("business/careers", 1.5), candidate("engineering/ai-robotics", 0.75, { generic: true })]);
    const decision = chooseTopic(result, supplyOf([["business/careers", 0], ["engineering", 334], ["engineering/ai-robotics", 0]]));
    expect(topicDecisionLine(decision, "bodies")).toBe(
      "topic: business/careers -> engineering (supply-aware: 0 vs 334 usable transcripts; " +
        "candidates business/careers=0, engineering=334 (for engineering/ai-robotics), engineering/ai-robotics=0 (generic-only))"
    );
    expect(topicDecisionLine(chooseTopic(result, supplyOf([["business/careers", 9]])), "archive")).toBe(
      "topic: business/careers (best: 9 archive entries in family (no body source wired); " +
        "candidates business/careers=9, engineering=0 (for engineering/ai-robotics), engineering/ai-robotics=0 (generic-only))"
    );
  });

  it("a pinned topic is recorded as pinned, unscored, with its supply measured and said", () => {
    const decision = pinnedTopicDecision("food/grilling-bbq", supplyOf([["food/grilling-bbq", 21]]));
    expect(decision).toMatchObject({ topic: "food/grilling-bbq", resolved: null, reason: "pinned", minSupply: MIN_TOPIC_SUPPLY });
    expect(decision.considered).toEqual([{ id: "food/grilling-bbq", score: null, supply: 21, eligible: true }]);
    expect(topicDecisionLine(decision, "archive")).toBe("topic: food/grilling-bbq (pinned by the caller; 21 archive entries in family (no body source wired))");
  });
});

describe("run 8, replayed against the REAL taxonomy and semantic index (regressions)", () => {
  it("run 8's prompt: the resolver's pick is business/careers, and supply moves it to the engineering root that carries *Being an Engineer*", () => {
    /* The show nodes are the six run 8's machine reported; the archive is 334
       episodes of that show plus a dozen geology episodes nothing here should
       reach. MUTATION THAT KILLS THIS: any of the ones above — or measuring
       supply on `taxonomyNodesForShowId` alone rather than `nodesForArchiveEntry`
       changes nothing here, which is why the item-id join is pinned in
       taxonomyFamily.test.ts instead. */
    const root = fixtureRoot([show("being-an-engineer", BEING_AN_ENGINEER_RUN_8), show("geology-bites", ["nature/earth-science"])]);
    const archive = [...episodes("being-an-engineer", 334), ...episodes("geology-bites", 12)];
    const resolved = resolveTopic(RUN_8_PROMPT, { root });
    expect(resolved.resolved).toBe("business/careers");
    const supply = measureTopicSupply(consideredTopicIds(resolved, { root }), { archive, root });
    expect(supply.get("business/careers")?.usable).toBe(0);
    const decision = chooseTopic(resolved, supply, { root });
    expect(decision.reason).toBe("supply-aware");
    expect(decision.resolved).toBe("business/careers");
    expect(taxonomyRoot(decision.topic)).toBe("engineering");
    expect(decision.topic).toBe("engineering");
    expect(decision.considered.find((c) => c.id === decision.topic)?.supply).toBe(334);
    expect(supply.get(decision.topic!)?.byShow).toEqual({ "being-an-engineer": 334 });
  });

  it("run 8's prompt on main's own classification of the show (precision-mfg + craft/diy-home): only the root stand-in reaches it", () => {
    /* On origin/main `being-an-engineer` is `engineering/precision-mfg`, a
       SIBLING of every engineering child on the shortlist, so no child's
       lineage admits it and only `engineering` itself does. Without the
       stand-in this prompt would still stop `no-supply` on main's data. */
    const root = fixtureRoot([show("being-an-engineer", BEING_AN_ENGINEER_MAIN)]);
    const resolved = resolveTopic(RUN_8_PROMPT, { root });
    const decision = chooseTopic(resolved, measureTopicSupply(consideredTopicIds(resolved, { root }), { archive: episodes("being-an-engineer", 337), root }), { root });
    expect(decision).toMatchObject({ topic: "engineering", resolved: "business/careers", reason: "supply-aware" });
    /* Which generic-only child lends the root is the shortlist's first — a
       candidate that matched the WORD "engineering", whichever root it sits under. */
    expect(decision.considered.find((c) => c.id === "engineering")?.standInFor).toMatch(/engineering/);
  });

  it("the India prompt: cities/urbanism resolves, nothing in an engineering-only archive is in any candidate's family, and the verdict is no-supply", () => {
    const root = fixtureRoot([show("being-an-engineer", BEING_AN_ENGINEER_RUN_8)]);
    const resolved = resolveTopic(INDIA_PROMPT, { root });
    expect(resolved.resolved).toBe("cities/urbanism");
    const decision = chooseTopic(resolved, measureTopicSupply(consideredTopicIds(resolved, { root }), { archive: episodes("being-an-engineer", 334), root }), { root });
    expect(decision).toMatchObject({ topic: "cities/urbanism", reason: "no-supply" });
    /* `history` — the root "history" names — was weighed and had nothing; `food` was never in the room. */
    expect(decision.considered.find((c) => c.id === "history")).toMatchObject({ supply: 0, eligible: true });
    expect(decision.considered.some((c) => c.id === "food")).toBe(false);
    expect(noSupplyReason(decision, "archive")).toContain("cities/urbanism=0");
  });
});
