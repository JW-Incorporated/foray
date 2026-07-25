import { z } from "zod";

/**
 * Matches data/ladders.json exactly (docs/curation/personalization-and-depth-plan.md
 * §6, "Depth-laddered playlists"). A ladder is a prerequisite-ordered curriculum
 * over episodes already in the catalogue (session.json ∪ discover.json) — see
 * backend/src/curation/ladderBuilder.ts for how rungs are assembled.
 */

export const LadderLevelSchema = z.enum(["overview", "fundamentals", "deep-dive", "frontier"]);
export type LadderLevel = z.infer<typeof LadderLevelSchema>;

export const LadderStatusSchema = z.enum(["draft", "published"]);
export type LadderStatus = z.infer<typeof LadderStatusSchema>;

export const LadderRungSchema = z.object({
  // Unique within the ladder. This is the prerequisite key — `prerequisites`
  // below references other rungs' `id`s, never their `level` (levels repeat
  // across parallel deep-dive branches, so they can't double as identifiers).
  id: z.string().min(1),
  level: LadderLevelSchema,
  // Human label for a deep-dive branch (e.g. "Tokamak"); null for rungs that
  // aren't branch-specific (overview/fundamentals/frontier).
  subtopic: z.string().nullable(),
  // <=18 words, same copy-rule gate as session card why-lines (see
  // src/copy/rules.js). One-line statement of what this rung teaches.
  goal: z.string().min(1),
  episode_ids: z.array(z.string()).min(1),
  // Rung ids this rung builds on. Advisory ordering metadata ONLY — never
  // access control. No rung is ever locked behind another in the UI (no
  // dark-pattern gating); this is purely for entry-rung inference (see
  // src/curation/ladderProgress.ts) and the CI acyclic-graph check.
  prerequisites: z.array(z.string())
});
export type LadderRung = z.infer<typeof LadderRungSchema>;

export const LadderSchema = z.object({
  id: z.string().min(1),
  // Must resolve to a data/taxonomy.json node id (see §5 of the plan: one
  // taxonomy for both catalogue and preferences).
  node: z.string().min(1),
  title: z.string().min(1),
  // "draft" ladders are reviewable (this schema, CI, tests all apply) but
  // must never be surfaced to end users until a founder flips it to
  // "published" — see docs/curation/ladders-client-spec.md.
  status: LadderStatusSchema,
  estimated_total_min: z.number().int().positive(),
  rungs: z.array(LadderRungSchema).min(1)
});
export type Ladder = z.infer<typeof LadderSchema>;

export const LaddersFileSchema = z.object({
  version: z.literal(1),
  built_at: z.string(),
  ladders: z.array(LadderSchema)
});
export type LaddersFile = z.infer<typeof LaddersFileSchema>;
