import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { SessionDocSchema } from "../src/types/session";
import { TaxonomyFileSchema } from "../src/types/taxonomy";
import { BANNED, COMMUTE_FRAMING } from "../src/copy/rules";

/**
 * #72 (REQUIREMENTS-DELTA R17): the REAL data/session.json, parsed with
 * SessionDocSchema, so that a card without provenance and a stretch card
 * without a bridge fail CI — not only a fixture shaped like it. The checks the
 * schema cannot make without file access (is this topic id a real taxonomy
 * node? a topic of this episode?) are made here against the real data files.
 * Spec: docs/curation/session-doc-v1.md#provenance.
 *
 * Mutations, each run against this suite (named per test below as well):
 *   - delete slot 2's "provenance" line from data/session.json -> red
 *   - delete `provenance: ProvenanceSchema` from SessionCardSchema -> red
 *   - delete SessionCardSchema's stretch-bridge superRefine -> red
 *   - loosen ProvenanceSignalSchema to z.string() -> red
 *   - delete SessionDocSchema's builder superRefine -> red
 *   - "topic:engineering/energy-fusion" -> "topic:engineering/fusion" in data -> red
 */

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const read = (rel: string) => fs.readFileSync(path.join(REPO_ROOT, rel), "utf-8");

/** A fresh deep copy of the real file every time, so no test can lean on
    another test's mutation of shared state. */
const realSession = (): any => JSON.parse(read("data/session.json"));
const taxonomyIds = new Set(TaxonomyFileSchema.parse(JSON.parse(read("data/taxonomy.json"))).nodes.map((n) => n.id));
const personaIds = new Set((JSON.parse(read("data/personas.json")).personas as { id: string }[]).map((p) => p.id));

function issuePaths(doc: unknown): string[] {
  const r = SessionDocSchema.safeParse(doc);
  return r.success ? [] : r.error.issues.map((i) => i.path.join("."));
}

describe("data/session.json carries valid provenance on every card (#72)", () => {
  /* MUTATION: delete slot 2's provenance line from data/session.json -> red
     (cards.1.provenance). */
  it("the real file parses with SessionDocSchema, provenance included", () => {
    const r = SessionDocSchema.safeParse(realSession());
    expect(r.success, r.success ? "" : JSON.stringify(r.error.issues, null, 2)).toBe(true);
    // Non-vacuity: the rules below need cards, and a stretch card for the bridge rule.
    const doc = realSession();
    expect(doc.cards.length).toBeGreaterThan(0);
    expect(doc.cards.some((c: any) => c.archetype === "stretch")).toBe(true);
  });

  /* The issue's honesty check on the real file: a topic signal must name a
     real taxonomy node AND a topic the card's own episode carries, so an
     invented or copied-in explanation cannot pass.
     MUTATION: "topic:engineering/energy-fusion" -> "topic:engineering/fusion"
     in data/session.json -> red (not a taxonomy node); slot 4's
     "topic:comedy/casual-hangs" -> "topic:science/materials" -> red (a real
     node, but not one of that episode's topics). */
  it("every topic signal is a real taxonomy node and one of the card's episode topics; every card has one", () => {
    const doc = realSession();
    const failures: string[] = [];
    for (const card of doc.cards) {
      const episodeTopics: string[] = doc.episodes[card.episode_id]?.topics ?? [];
      const topics = (card.provenance?.signals ?? []).filter((s: string) => s.startsWith("topic:")).map((s: string) => s.slice(6));
      if (topics.length === 0) failures.push(`slot ${card.slot}: no topic signal`);
      for (const t of topics) {
        if (!taxonomyIds.has(t)) failures.push(`slot ${card.slot}: topic:${t} is not a data/taxonomy.json node`);
        if (!episodeTopics.includes(t)) failures.push(`slot ${card.slot}: topic:${t} is not a topic of ${card.episode_id}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /* MUTATION: slot 1's "depth:high" -> "depth:low" in data -> red. */
  it("persona, pool and depth signals agree with the data they name", () => {
    const doc = realSession();
    const failures: string[] = [];
    for (const card of doc.cards) {
      for (const s of card.provenance?.signals ?? []) {
        const [kind, value] = s.split(":");
        if (kind === "persona" && !personaIds.has(value)) failures.push(`slot ${card.slot}: ${s} is not a data/personas.json persona`);
        if (kind === "pool" && value !== card.archetype) failures.push(`slot ${card.slot}: ${s} but archetype is ${card.archetype}`);
        if (kind === "depth" && value !== doc.episodes[card.episode_id]?.depth)
          failures.push(`slot ${card.slot}: ${s} but ${card.episode_id} has depth ${doc.episodes[card.episode_id]?.depth}`);
      }
    }
    expect(failures, failures.join("\n")).toEqual([]);
  });

  /* The bridge is card copy the iOS tap-through will render (R17), so it is
     held to the copy rules now rather than when the UI ships.
     MUTATION: append " — a fascinating deep dive" to slot 2's bridge -> red. */
  it("every stretch bridge obeys the copy rules", () => {
    const doc = realSession();
    const failures: string[] = [];
    let checked = 0;
    for (const card of doc.cards) {
      const bridge = card.provenance?.bridge;
      if (typeof bridge !== "string") continue;
      checked += 1;
      for (const rx of [...BANNED, ...COMMUTE_FRAMING]) if (rx.test(bridge)) failures.push(`slot ${card.slot} bridge: ${rx} in "${bridge}"`);
    }
    expect(checked, "no bridge was read, so this proved nothing").toBeGreaterThan(0);
    expect(failures, failures.join("\n")).toEqual([]);
  });
});

/* The negative half, on the real file's shape: each test removes exactly one
   thing from an otherwise-valid real document and asserts the schema names it.
   safeParse + the issue path, not toThrow(): a TypeError from a refinement
   reading a missing field would also "throw" and prove nothing. */
describe("SessionDocSchema rejects what #72 says CI must reject", () => {
  /* MUTATION: delete `provenance: ProvenanceSchema` from SessionCardSchema -> red. */
  it("a card without provenance fails", () => {
    const doc = realSession();
    delete doc.cards[0].provenance;
    expect(issuePaths(doc)).toContain("cards.0.provenance");
  });

  /* MUTATION: delete SessionCardSchema's stretch-bridge superRefine -> red. */
  it("a stretch card without a bridge fails; a non-stretch card without one passes", () => {
    const doc = realSession();
    const i = doc.cards.findIndex((c: any) => c.archetype === "stretch");
    expect(i).toBeGreaterThanOrEqual(0);
    delete doc.cards[i].provenance.bridge;
    expect(issuePaths(doc)).toContain(`cards.${i}.provenance.bridge`);

    const ok = realSession();
    const j = ok.cards.findIndex((c: any) => c.archetype !== "stretch");
    expect(ok.cards[j].provenance.bridge).toBeUndefined();
    expect(issuePaths(ok)).toEqual([]);
  });

  /* MUTATION: loosen ProvenanceSignalSchema to z.string() -> red ("placeholder"
     and "" validate); drop `.min(1)` from signals -> red ([] validates). */
  it("placeholder, empty and missing signals fail", () => {
    for (const signals of [["placeholder"], [""], ["topic:"], ["Topic:Engineering"], []]) {
      const doc = realSession();
      doc.cards[0].provenance.signals = signals;
      expect(issuePaths(doc).some((p) => p.startsWith("cards.0.provenance.signals")), JSON.stringify(signals)).toBe(true);
    }
  });

  /* MUTATION: delete SessionDocSchema's builder superRefine -> red; remove
     `.strict()` from ProvenanceSchema -> red (the typo'd key validates). */
  it("a provenance builder that differs from the session's, or an unknown key, fails", () => {
    const doc = realSession();
    doc.cards[0].provenance.builder = "some-other-builder";
    expect(issuePaths(doc)).toContain("cards.0.provenance.builder");

    const typo = realSession();
    typo.cards[0].provenance.wild_card = true;
    expect(issuePaths(typo)).toContain("cards.0.provenance");
  });

  /* MUTATION: make `wildcard` optional in ProvenanceSchema -> red. */
  it("a card without the wildcard flag fails", () => {
    const doc = realSession();
    delete doc.cards[0].provenance.wildcard;
    expect(issuePaths(doc)).toContain("cards.0.provenance.wildcard");
  });
});
