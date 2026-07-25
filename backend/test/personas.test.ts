import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PersonasFileSchema } from "../src/types/personas";
import { TaxonomyFileSchema } from "../src/types/taxonomy";

/**
 * data/personas.json schema + referential-integrity + copy-rule checks
 * (personalization-and-depth-plan.md §3a/§5). Mirrors poolIntegrity.test.ts's
 * "every referenced node resolves to a real taxonomy node" pattern.
 *
 * Note: this file keeps its OWN inline banned-phrase list rather than
 * importing/editing backend/test/copyRules.test.ts, which is being factored
 * into a shared backend/src/copy/rules.ts module in a parallel change. Once
 * that module lands, swap this inline list for an import.
 */

const dataDir = join(__dirname, "..", "..", "data");
const personasRaw = JSON.parse(readFileSync(join(dataDir, "personas.json"), "utf8"));
const taxonomyRaw = JSON.parse(readFileSync(join(dataDir, "taxonomy.json"), "utf8"));

const BANNED = [
  /fascinat/i,
  /deep[\s-]dive/i,
  /delve/i,
  /\bexplores?\b/i,
  /you won'?t believe/i,
  /fits? your drive/i,
  /your commute\b/i,
  /-min(ute)? drive/i
];

describe("data/personas.json schema", () => {
  it("validates against PersonasFileSchema", () => {
    expect(() => PersonasFileSchema.parse(personasRaw)).not.toThrow();
  });

  it("has exactly one persona matching default_persona_id, and it's 'generalist'", () => {
    const file = PersonasFileSchema.parse(personasRaw);
    expect(file.default_persona_id).toBe("generalist");
    const matches = file.personas.filter((p) => p.id === file.default_persona_id);
    expect(matches).toHaveLength(1);
  });

  it("has no duplicate persona ids", () => {
    const file = PersonasFileSchema.parse(personasRaw);
    const ids = file.personas.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe("data/personas.json referential integrity", () => {
  const taxonomy = TaxonomyFileSchema.parse(taxonomyRaw);
  const nodeIds = new Set(taxonomy.nodes.map((n) => n.id));

  it("every persona weight's node_id resolves to a real taxonomy node", () => {
    const file = PersonasFileSchema.parse(personasRaw);
    const orphans: string[] = [];
    for (const persona of file.personas) {
      for (const w of persona.weights) {
        if (!nodeIds.has(w.node_id)) orphans.push(`${persona.id}:${w.node_id}`);
      }
    }
    expect(orphans).toEqual([]);
  });

  it("the generalist persona covers every top-level taxonomy node (broad by construction)", () => {
    const file = PersonasFileSchema.parse(personasRaw);
    const generalist = file.personas.find((p) => p.id === "generalist")!;
    const covered = new Set(generalist.weights.map((w) => w.node_id));
    const topLevelIds = taxonomy.nodes.filter((n) => n.parent === null).map((n) => n.id);
    const missing = topLevelIds.filter((id) => !covered.has(id));
    expect(missing).toEqual([]);
  });
});

describe("data/personas.json copy rules", () => {
  it("every persona label/description obeys the banned-phrase list", () => {
    const file = PersonasFileSchema.parse(personasRaw);
    const failures: string[] = [];
    for (const persona of file.personas) {
      for (const field of ["label", "description"] as const) {
        const text = persona[field];
        for (const rx of BANNED) {
          if (rx.test(text)) failures.push(`${persona.id}.${field}: banned ${rx}: "${text}"`);
        }
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });
});
