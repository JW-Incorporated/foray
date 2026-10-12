import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import {
  DEFAULT_DENSE_EXTRA,
  mergeCandidates,
  nodeShortlistQuery,
  rankByScore,
  reciprocalRankFusion,
  scorePassagesBm25,
  type DenseHit,
  type LexicalCandidate
} from "../src/generation/hybridRetrieval";

/**
 * GV-48 (docs/roadmap/generation-v2.md, from W3-09): the pure hybrid merge.
 * Literal candidates and hits only; no index, no store, no model.
 */

const lex = (guid: string, rank: number, score = 10 - rank, show = "s1"): LexicalCandidate => ({ show_id: show, guid, score, matchedTerms: 3, rank });
const hit = (guid: string, passageId: string, sim: number, show = "s1"): DenseHit => ({
  show_id: show,
  guid,
  passageId,
  sim,
  startSec: 60,
  endSec: 180,
  startBoundary: "sentence",
  endBoundary: "turn"
});

const BM25 = [lex("a", 0), lex("b", 1), lex("c", 2)];
const IDF = new Map([
  ["semmelweis", 4.2],
  ["fever", 1.1]
]);

describe("mergeCandidates — 'append' (the default) only adds", () => {
  it("every BM25 candidate keeps its order, rank and score; dense-only episodes follow, at most denseExtra, in dense order", () => {
    /* MUTATIONS THAT KILL THIS: drop the `added >= denseExtra` break (all six
       dense-only episodes are appended); push dense-only episodes BEFORE the
       BM25 list; skip the `lexicalKeys.has` test (b appears twice). Ran the
       first — red. */
    const dense = [hit("x1", "p-x1", 0.9), hit("b", "p-b", 0.85), hit("x2", "p-x2", 0.8), hit("x3", "p-x3", 0.7), hit("x4", "p-x4", 0.6), hit("x5", "p-x5", 0.5), hit("x6", "p-x6", 0.4)];
    const merged = mergeCandidates(BM25, dense, { idf: IDF });
    expect(DEFAULT_DENSE_EXTRA).toBe(4);
    expect(merged.map((c) => c.guid)).toEqual(["a", "b", "c", "x1", "x2", "x3", "x4"]);
    expect(merged.map((c) => c.rank)).toEqual([0, 1, 2, 3, 4, 5, 6]);
    for (const c of BM25) {
      const out = merged.find((m) => m.guid === c.guid);
      expect(out).toMatchObject({ score: c.score, matchedTerms: c.matchedTerms, rank: c.rank });
    }
    expect(merged.map((c) => c.via)).toEqual(["bm25", "both", "bm25", "dense", "dense", "dense", "dense"]);
    expect(merged.slice(3).every((c) => c.score === 0 && c.matchedTerms === 0)).toBe(true);
    expect(mergeCandidates(BM25, dense, { denseExtra: 1 }).map((c) => c.guid)).toEqual(["a", "b", "c", "x1"]);
    expect(mergeCandidates(BM25, dense, { denseExtra: 0 }).map((c) => c.guid)).toEqual(["a", "b", "c"]);
    expect(mergeCandidates([], dense, { denseExtra: 2 }).map((c) => c.guid)).toEqual(["x1", "b"]);
  });

  it("each episode carries its BEST passage (hits sorted here, ties by passage id); bm25-only candidates carry none", () => {
    /* MUTATION THAT KILLS THIS: keep the FIRST hit seen per episode instead of
       sorting by sim (x1's best passage becomes p-x1-low). Ran it — red. */
    const dense = [hit("x1", "p-x1-low", 0.3), hit("b", "p-b-2", 0.6), hit("x1", "p-x1-high", 0.9), hit("b", "p-b-1", 0.6)];
    const merged = mergeCandidates(BM25, dense);
    const x1 = merged.find((c) => c.guid === "x1");
    expect(x1?.passage).toEqual({ passageId: "p-x1-high", startSec: 60, endSec: 180, startBoundary: "sentence", endBoundary: "turn" });
    expect(x1?.denseSim).toBe(0.9);
    expect(merged.find((c) => c.guid === "b")?.passage?.passageId).toBe("p-b-1");
    expect(merged.find((c) => c.guid === "a")).toMatchObject({ via: "bm25", passage: null, denseSim: null });
    expect(merged.filter((c) => c.via === "dense").map((c) => c.guid)).toEqual(["x1"]);
  });

  it("every candidate, dense-only included, carries the query's BM25 idf map (the same object)", () => {
    /* MUTATION THAT KILLS THIS: give dense-only candidates `new Map()` (the
       window floor would weigh every term 1 for them). Ran it — red. */
    const merged = mergeCandidates(BM25, [hit("x1", "p", 0.5)], { idf: IDF });
    expect(merged).toHaveLength(4);
    for (const c of merged) expect(c.idf).toBe(IDF);
    expect(mergeCandidates(BM25, []).every((c) => c.idf.size === 0)).toBe(true);
  });

  it("is deterministic and equal for the same inputs in any hit order; bad options are refused", () => {
    const dense = [hit("x2", "p2", 0.5), hit("x1", "p1", 0.5), hit("x3", "p3", 0.7)];
    const a = mergeCandidates(BM25, dense);
    const b = mergeCandidates(BM25, [...dense].reverse());
    expect(a).toEqual(b);
    expect(a.slice(3).map((c) => c.guid)).toEqual(["x3", "x1", "x2"]);
    expect(() => mergeCandidates(BM25, dense, { denseExtra: -1 })).toThrow(/denseExtra/);
    expect(() => mergeCandidates(BM25, dense, { policy: "max" as never })).toThrow(/policy/);
    /* Same guid on another show is another episode. */
    expect(mergeCandidates([lex("a", 0)], [hit("a", "p", 0.9, "s2")]).map((c) => `${c.show_id}/${c.guid}/${c.via}`)).toEqual(["s1/a/bm25", "s2/a/dense"]);
  });
});

describe("mergeCandidates — 'rrf' (evaluation only)", () => {
  it("fuses episode ranks with 1/(k + rank + 1), caps at bm25.length + denseExtra, ties by BM25 rank", () => {
    /* MUTATION THAT KILLS THIS: use 1/(k + rank) (no +1): with k = 0 the top
       of each list divides by zero and every score is Infinity. Ran it — red. */
    const dense = [hit("c", "pc", 0.9), hit("x1", "px", 0.8), hit("a", "pa", 0.1)];
    const merged = mergeCandidates(BM25, dense, { policy: "rrf", k: 0, denseExtra: 1 });
    /* a: 1/1 + 1/3; c: 1/3 + 1/1; b: 1/2; x1: 1/2. a and c tie, BM25 rank decides. */
    expect(merged.map((c) => c.guid)).toEqual(["a", "c", "b", "x1"]);
    expect(merged[0]?.score).toBeCloseTo(1 + 1 / 3, 10);
    expect(merged[2]?.score).toBeCloseTo(1 / 2, 10);
    expect(merged.map((c) => c.via)).toEqual(["both", "both", "bm25", "dense"]);
    expect(merged.map((c) => c.rank)).toEqual([0, 1, 2, 3]);
    const fused = reciprocalRankFusion([["a", "b"], ["b", "a", "a"]], 60);
    expect(fused.get("a")).toBeCloseTo(1 / 61 + 1 / 62, 12);
  });
});

describe("passage BM25 and the node shortlist query", () => {
  it("scores passages by BM25 with the given idf where it has the term, ranks only matches, best first", () => {
    /* MUTATION THAT KILLS THIS: ignore the given idf (the local idf makes
       'fever' the rarer word and flips p1 and p2). */
    const passages = [
      { passageId: "p1", text: "Semmelweis studied the wards." },
      { passageId: "p2", text: "Fever fever fever in the wards." },
      { passageId: "p3", text: "Nothing related at all." },
      { passageId: "p4", text: "Fever charts and fever wards and semmelweis" }
    ];
    const scores = scorePassagesBm25("semmelweis fever", passages, { idf: new Map([["semmelweis", 5], ["fever", 0.1]]) });
    expect(scores.get("p3")).toBe(0);
    const ranked = rankByScore(scores);
    expect(ranked[0]).toBe("p1");
    expect(ranked.indexOf("p1")).toBeLessThan(ranked.indexOf("p2"));
    expect(ranked).not.toContain("p3");
    expect(rankByScore(scorePassagesBm25("semmelweis fever", passages)).indexOf("p2")).toBeLessThan(
      rankByScore(scorePassagesBm25("semmelweis fever", passages)).indexOf("p1")
    );
  });

  it("a node's query is its label, its children's labels and the terms of concepts the label matches in its lineage", () => {
    /* MUTATIONS THAT KILL THIS: leave out the child labels; match concepts
       with no topic (the off-branch stem-only 'medicaid' concept leaks in). */
    const nodes = [
      { id: "medicine", parent: null, label: "Medicine" },
      { id: "medicine/history", parent: "medicine", label: "History of medicine" },
      { id: "medicine/germ-theory", parent: "medicine", label: "Germ theory" },
      { id: "politics", parent: null, label: "Politics" }
    ];
    const concepts = {
      medicine: { terms: ["medicine", "medical", "germ-theory"], topics: ["medicine"], related: [] },
      medicaid: { terms: ["medicin"], topics: ["politics"], related: [] },
      geology: { terms: ["rocks"], topics: ["science/geology"], related: [] }
    };
    expect(nodeShortlistQuery(nodes[0]!, nodes, concepts)).toBe("Medicine History of medicine Germ theory medical");
    expect(nodeShortlistQuery(nodes[3]!, nodes, concepts)).toBe("Politics");
  });

  it("covers the committed taxonomy: 194 nodes, each with a non-empty query", () => {
    const root = path.resolve(__dirname, "..", "..");
    const taxonomy = JSON.parse(fs.readFileSync(path.join(root, "data", "taxonomy.json"), "utf8")) as { nodes: Array<{ id: string; parent: string | null; label: string }> };
    const concepts = (JSON.parse(fs.readFileSync(path.join(root, "data", "semantic-index.json"), "utf8")) as { concepts: Record<string, { terms: string[]; topics: string[]; related: string[] }> }).concepts;
    expect(taxonomy.nodes).toHaveLength(194);
    for (const node of taxonomy.nodes) expect(nodeShortlistQuery(node, taxonomy.nodes, concepts).length, node.id).toBeGreaterThan(0);
  });
});

describe("no backend test imports node:sqlite", () => {
  it("no file under backend/test imports node:sqlite or the passage store module", () => {
    /* MUTATION THAT KILLS THIS: import tools/passage-index/store.mjs from
       retrievalServer.test.ts (vitest would then need node:sqlite). */
    const dir = __dirname;
    /* A quoted specifier of either module: an import, a dynamic import, a
       require, or the last segment of a path built with path.join. */
    const needles = [/["']node:sqlite["']/, /["'][^"'\n]*passage-index\/store\.mjs["']/, /["']store\.mjs["']/];
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const name of fs.readdirSync(d)) {
        const full = path.join(d, name);
        if (fs.statSync(full).isDirectory()) walk(full);
        else if (/\.(ts|js|mjs)$/.test(name) && needles.some((n) => n.test(fs.readFileSync(full, "utf8")))) offenders.push(path.relative(dir, full));
      }
    };
    walk(dir);
    expect(offenders).toEqual([]);
  });
});
