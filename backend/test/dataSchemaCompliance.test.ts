import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SessionDocSchema } from "../src/types/session";
import { TaxonomyFileSchema } from "../src/types/taxonomy";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

describe("our zod schemas match the repo's existing data files exactly", () => {
  it("data/session.json (version 1, the web client's existing contract) validates against SessionDocSchema", () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, "data", "session.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(() => SessionDocSchema.parse(parsed)).not.toThrow();
  });

  it("data/taxonomy.json validates against TaxonomyFileSchema", () => {
    const raw = fs.readFileSync(path.join(REPO_ROOT, "data", "taxonomy.json"), "utf-8");
    const parsed = JSON.parse(raw);
    expect(() => TaxonomyFileSchema.parse(parsed)).not.toThrow();
  });
});

describe("data/taxonomy.json structural invariants (docs/research/taxonomy-review-2026-08.md)", () => {
  const tax = TaxonomyFileSchema.parse(
    JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "data", "taxonomy.json"), "utf-8"))
  );
  const ids = new Set(tax.nodes.map((n) => n.id));
  const roots = tax.nodes.filter((n) => n.parent === null);
  const children = tax.nodes.filter((n) => n.parent !== null);

  it("node ids are unique", () => {
    expect(ids.size).toBe(tax.nodes.length);
  });

  it("stays exactly two levels deep — every parent exists and is itself top-level", () => {
    const byId = new Map(tax.nodes.map((n) => [n.id, n]));
    for (const n of children) {
      const parent = byId.get(n.parent!);
      expect(parent, `node "${n.id}" has missing parent "${n.parent}"`).toBeDefined();
      expect(parent!.parent, `node "${n.id}" is a third level under "${n.parent}"`).toBeNull();
    }
  });

  it("child ids are namespaced as `<parent>/<leaf>`", () => {
    // tools/transcribe/fetch-audio.mjs and topic-coverage-report.mjs both derive
    // the branch by splitting on "/", so this convention is load-bearing.
    for (const n of children) {
      expect(n.id.startsWith(`${n.parent}/`), `node "${n.id}" is not under "${n.parent}/"`).toBe(true);
      expect(n.id.slice(n.parent!.length + 1)).not.toContain("/");
    }
  });

  it("every top-level branch has at least one child", () => {
    // app.js's leafNodes() renders only non-root nodes as interest sliders, so a
    // childless branch is unreachable in the UI no matter how much content it
    // holds. Six branches (true-crime, hobbies, relationships, travel,
    // personal-journals, paranormal) were in that state before 2026-08 and
    // stranded 1,224 breadth shows plus 181 curated episodes.
    const withChildren = new Set(children.map((n) => n.parent));
    const childless = roots.filter((r) => !withChildren.has(r.id)).map((r) => r.id);
    expect(childless, `top-level branches with no child: ${childless.join(", ")}`).toEqual([]);
  });

  it("labels are non-empty and unique within a branch", () => {
    for (const n of tax.nodes) expect(n.label.trim().length, `node "${n.id}" has an empty label`).toBeGreaterThan(0);
    const seen = new Map<string, string>();
    for (const n of children) {
      const key = `${n.parent}::${n.label.toLowerCase()}`;
      expect(seen.has(key), `duplicate label "${n.label}" under "${n.parent}"`).toBe(false);
      seen.set(key, n.id);
    }
  });

  it("a food branch exists with a home for grilling and barbecue", () => {
    // Regression guard for the 2026-08 review: this is the branch the
    // history-of-grilling Foray is tagged against, and merge-segments.mjs
    // rejects any segment whose topic is not a node here.
    expect(ids.has("food")).toBe(true);
    expect(ids.has("food/grilling-bbq")).toBe(true);
    expect(ids.has("food/food-history")).toBe(true);
  });
});
