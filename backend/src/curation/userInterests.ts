import * as fs from "fs";
import * as path from "path";
import type { TaxonomyFile, TaxonomyNode } from "../types/taxonomy";
import { PersonasFileSchema, type Persona } from "../types/personas";

/**
 * Per-user interest state (personalization-and-depth-plan.md §3a/§4/§8 Step
 * A+B). This is the first runtime seam for per-user data in the curation
 * engine — everything before this module reads only the global
 * data/taxonomy.json. Follows the same pluggable-I/O shape as
 * src/enrich/Enricher.ts and src/cost/costEvents.ts's CostEventSink: an
 * interface, a keyless in-memory default (used by tests and any CLI run
 * without DATABASE_URL), and a real backing store swapped in later without
 * touching call sites.
 */

export interface UserTaxonomyRow {
  nodeId: string;
  weight: number;
  confidence: number;
  source: "onboarding-interview" | "inferred" | "voice-mutation" | "manual-edit" | "persona-seed";
}

export interface UserInterestsProvider {
  /** Real per-user rows observed/edited so far. Empty = nothing seeded/observed yet. */
  getUserTaxonomyNodes(userId: string): Promise<UserTaxonomyRow[]>;
  /** app_users.persona_seed — null if unset. */
  getPersonaSeed(userId: string): Promise<string | null>;
  /** Resolves a persona id against data/personas.json. */
  getPersona(personaId: string): Promise<Persona | undefined>;
  /**
   * Materializes the named persona's weights into real per-user rows
   * (top-level nodes only — see resolveEffectiveTaxonomy for why nested
   * nodes don't need their own row). Idempotent: a no-op if the user
   * already has any taxonomy_nodes rows.
   */
  seedFromPersona(userId: string, personaId: string): Promise<void>;
}

function topLevelOf(nodeId: string): string {
  return nodeId.split("/")[0] ?? nodeId;
}

/**
 * Per-node three-tier fallback (plan §3a/§4/§8 Step A):
 *   1. a real per-user taxonomy_nodes row for this exact node_id -> observed
 *      state, always wins (principle #2: state observed, never declared).
 *   2. the user's persona weight for this node_id, else its top-level
 *      ancestor's persona weight -> a decaying cold-start prior.
 *   3. data/taxonomy.json's own weight for this node -> today's global
 *      behavior, unchanged (also what a user with no persona and no rows —
 *      e.g. dev/CLI defaults — gets).
 *
 * Node *metadata* (label, apple_anchor, parent) always comes from the global
 * taxonomy; only weight/confidence vary per user. Returns the same
 * TaxonomyNode[] shape scoring.ts already consumes, so scoring.ts needs no
 * changes at all — only which array gets passed to it changes.
 */
export function resolveEffectiveTaxonomy(
  globalTaxonomy: TaxonomyFile,
  userRows: UserTaxonomyRow[],
  persona: Persona | undefined
): TaxonomyNode[] {
  const userByNode = new Map(userRows.map((r) => [r.nodeId, r]));
  const personaByNode = persona ? new Map(persona.weights.map((w) => [w.node_id, w.weight])) : undefined;

  return globalTaxonomy.nodes.map((node) => {
    const userRow = userByNode.get(node.id);
    if (userRow) {
      return { ...node, weight: userRow.weight, confidence: userRow.confidence };
    }

    if (personaByNode && persona) {
      const personaWeight = personaByNode.get(node.id) ?? personaByNode.get(topLevelOf(node.id));
      if (personaWeight !== undefined) {
        return { ...node, weight: personaWeight, confidence: persona.seed_confidence };
      }
    }

    return node; // tier 3: global taxonomy's own weight/confidence, unchanged
  });
}

/**
 * Materializes a persona into the top-level-only row set seeding writes
 * (src/curation/userInterests.ts's UserInterestsProvider.seedFromPersona
 * implementations should use this so the shape is identical everywhere).
 * Top-level-only is deliberate (plan review 2026-07-24): a freshly-seeded
 * user's taxonomy_nodes table stays honestly sparse — every row it has is a
 * real stated prior, not an inherited default — and nested nodes continue to
 * resolve through resolveEffectiveTaxonomy's tier 2/3 until real evidence or
 * a future persona re-seed covers them.
 */
export function materializePersonaSeedRows(persona: Persona): UserTaxonomyRow[] {
  return persona.weights.map((w) => ({
    nodeId: w.node_id,
    weight: w.weight,
    confidence: persona.seed_confidence,
    source: "persona-seed"
  }));
}

function loadPersonasFile(personasPath: string): Persona[] {
  // eslint-disable-next-line security/detect-non-literal-fs-filename -- personasPath is a hardcoded repo-relative path built from __dirname, not external input.
  const raw = fs.readFileSync(personasPath, "utf-8");
  return PersonasFileSchema.parse(JSON.parse(raw)).personas;
}

const DEFAULT_PERSONAS_PATH = path.resolve(__dirname, "..", "..", "..", "data", "personas.json");

/**
 * Keyless default provider — an in-process Map, no database required. This
 * is what the CLI and every test use today (mirrors InMemoryCostEventSink).
 * A Postgres-backed provider (reading taxonomy_nodes/app_users) lands once
 * DB credentials are wired into src/config/env.ts — see
 * createUserInterestsProvider.ts for the env-gated seam it will plug into.
 */
export class InMemoryUserInterestsProvider implements UserInterestsProvider {
  private readonly userRows = new Map<string, UserTaxonomyRow[]>();
  private readonly personaSeeds = new Map<string, string | null>();
  private readonly personas: Persona[];

  constructor(personasPath: string = DEFAULT_PERSONAS_PATH) {
    this.personas = loadPersonasFile(personasPath);
  }

  /** Test/CLI helper: set a user's persona_seed (app_users.persona_seed equivalent). */
  setPersonaSeed(userId: string, personaId: string | null): void {
    this.personaSeeds.set(userId, personaId);
  }

  /** Test helper: inspect/seed real rows directly, bypassing seedFromPersona. */
  setUserTaxonomyNodes(userId: string, rows: UserTaxonomyRow[]): void {
    this.userRows.set(userId, rows);
  }

  async getUserTaxonomyNodes(userId: string): Promise<UserTaxonomyRow[]> {
    return [...(this.userRows.get(userId) ?? [])];
  }

  async getPersonaSeed(userId: string): Promise<string | null> {
    // No implicit default here: an *unknown* user id (never explicitly given
    // a seed via setPersonaSeed) resolves to null, not "generalist" — this
    // provider represents "nothing known about this user," and a real new
    // user only gets 'generalist' because the 0014 migration sets it as the
    // literal app_users.persona_seed column default (an explicit, written,
    // inspectable row — principle #2). Presuming a persona here for any
    // caller that happens not to have called setPersonaSeed would risk
    // silently overriding a real user's own observed taxonomy_nodes rows —
    // e.g. the CLI's SEEDED_USER_ID, whose real preferences already live in
    // data/taxonomy.json, must keep falling through to tier 3, not get
    // flattened onto a generic prior.
    return this.personaSeeds.get(userId) ?? null;
  }

  async getPersona(personaId: string): Promise<Persona | undefined> {
    return this.personas.find((p) => p.id === personaId);
  }

  async seedFromPersona(userId: string, personaId: string): Promise<void> {
    const existing = this.userRows.get(userId);
    if (existing && existing.length > 0) return; // idempotent: never overwrite real state

    const persona = await this.getPersona(personaId);
    if (!persona) return; // unknown persona id — nothing to seed, caller falls through to tier 3

    this.userRows.set(userId, materializePersonaSeedRows(persona));
  }
}
