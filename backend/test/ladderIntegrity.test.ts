import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LaddersFileSchema } from "../src/types/ladders";
import { BANNED, MAX_WHY_LINE_WORDS, wordCount } from "../src/copy/rules";

/**
 * Referential + structural integrity for data/ladders.json — the gate a
 * ladder-authoring PR relies on before merge (mirrors poolIntegrity.test.ts's
 * role for discover.json/item-tags.json). Covers everything
 * docs/curation/personalization-and-depth-plan.md §6 and the Step-D plan
 * promised as CI-checked:
 *   - referenced episode ids exist (session.json ∪ discover.json)
 *   - the node resolves to a real taxonomy node
 *   - prerequisites form a DAG (no cycles)
 *   - copy rules on ladder titles + rung goals (shared src/copy/rules.js)
 */

const dataDir = join(__dirname, "..", "..", "data");
const laddersRaw = JSON.parse(readFileSync(join(dataDir, "ladders.json"), "utf8"));
const session = JSON.parse(readFileSync(join(dataDir, "session.json"), "utf8"));
const discover = JSON.parse(readFileSync(join(dataDir, "discover.json"), "utf8"));
const taxonomy = JSON.parse(readFileSync(join(dataDir, "taxonomy.json"), "utf8"));

const ladders = LaddersFileSchema.parse(laddersRaw);
const taxonomyNodeIds = new Set(taxonomy.nodes.map((n: { id: string }) => n.id));
const catalogueEpisodeIds = new Set([...Object.keys(session.episodes), ...discover.items.map((i: { id: string }) => i.id)]);

describe("data/ladders.json schema", () => {
  it("parses against LaddersFileSchema", () => {
    // If this throws, the .parse() above already failed the test file to load;
    // this assertion just gives a named, readable failure in the report.
    expect(ladders.version).toBe(1);
  });

  it("has at least one ladder", () => {
    expect(ladders.ladders.length).toBeGreaterThan(0);
  });
});

describe("each ladder", () => {
  for (const ladder of ladders.ladders) {
    describe(`"${ladder.id}"`, () => {
      it("resolves `node` to a real taxonomy node", () => {
        expect(taxonomyNodeIds.has(ladder.node), `unknown node "${ladder.node}"`).toBe(true);
      });

      it("has unique rung ids", () => {
        const ids = ladder.rungs.map((r) => r.id);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("every episode_id exists in session.json or discover.json", () => {
        const missing: string[] = [];
        for (const rung of ladder.rungs) {
          for (const id of rung.episode_ids) {
            if (!catalogueEpisodeIds.has(id)) missing.push(`${rung.id}: ${id}`);
          }
        }
        expect(missing).toEqual([]);
      });

      it("no episode is reused across rungs within the same ladder", () => {
        const seen = new Map<string, string>();
        const dupes: string[] = [];
        for (const rung of ladder.rungs) {
          for (const id of rung.episode_ids) {
            if (seen.has(id)) dupes.push(`${id} in both "${seen.get(id)}" and "${rung.id}"`);
            else seen.set(id, rung.id);
          }
        }
        expect(dupes).toEqual([]);
      });

      it("every prerequisite references an existing rung id in the same ladder", () => {
        const rungIds = new Set(ladder.rungs.map((r) => r.id));
        const dangling: string[] = [];
        for (const rung of ladder.rungs) {
          for (const prereq of rung.prerequisites) {
            if (!rungIds.has(prereq)) dangling.push(`${rung.id} -> ${prereq}`);
          }
        }
        expect(dangling).toEqual([]);
      });

      it("the prerequisite graph is acyclic (a DAG)", () => {
        expect(findCycle(ladder.rungs)).toBeNull();
      });

      it("estimated_total_min equals the sum of every distinct episode's duration", () => {
        const allIds = new Set(ladder.rungs.flatMap((r) => r.episode_ids));
        const durationOf = (id: string): number => {
          const sessionEp = session.episodes[id] as { duration_min?: number } | undefined;
          if (sessionEp?.duration_min) return sessionEp.duration_min;
          const discoverItem = discover.items.find((i: { id: string }) => i.id === id) as
            | { duration_min?: number }
            | undefined;
          return discoverItem?.duration_min ?? 0;
        };
        const total = [...allIds].reduce((sum, id) => sum + durationOf(id), 0);
        expect(ladder.estimated_total_min).toBe(total);
      });

      it("title passes copy rules (no banned phrases)", () => {
        for (const rx of BANNED) {
          expect(ladder.title, `banned phrase ${rx} in title: "${ladder.title}"`).not.toMatch(rx);
        }
      });

      for (const rung of ladder.rungs) {
        it(`rung "${rung.id}" goal obeys copy rules (<=${MAX_WHY_LINE_WORDS} words, no banned phrases)`, () => {
          expect(rung.goal, "goal missing").toBeTruthy();
          expect(wordCount(rung.goal), `too long: "${rung.goal}"`).toBeLessThanOrEqual(MAX_WHY_LINE_WORDS);
          for (const rx of BANNED) {
            expect(rung.goal, `banned phrase ${rx} in: "${rung.goal}"`).not.toMatch(rx);
          }
        });
      }
    });
  }
});

/** DFS-based cycle detector over the rung-id prerequisite graph. Returns the
 * first offending rung id found, or null if the graph is acyclic. */
function findCycle(rungs: { id: string; prerequisites: string[] }[]): string | null {
  const graph = new Map(rungs.map((r) => [r.id, r.prerequisites]));
  const state = new Map<string, 0 | 1 | 2>(); // 0 unvisited, 1 visiting, 2 done

  function visit(id: string): boolean {
    const s = state.get(id) ?? 0;
    if (s === 1) return true; // back-edge -> cycle
    if (s === 2) return false;
    state.set(id, 1);
    for (const prereq of graph.get(id) ?? []) {
      if (visit(prereq)) return true;
    }
    state.set(id, 2);
    return false;
  }

  for (const id of graph.keys()) {
    if (visit(id)) return id;
  }
  return null;
}
