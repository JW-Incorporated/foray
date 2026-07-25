import { z } from "zod";

/**
 * Matches data/personas.json exactly (personalization-and-depth-plan.md §3a,
 * §5 — "Personas are versioned data, reviewed like content, not code
 * constants"). Persona weight vectors are cold-start PRIORS ONLY (principle
 * #2, "state observed, never declared"): they seed a new user's
 * taxonomy_nodes rows (see src/curation/userInterests.ts) at a deliberately
 * low confidence and are expected to be overwritten by real observed signal
 * once Step C (event capture) ships. They are never standing config.
 *
 * Persona content beyond the "generalist" default is Joey's call (tracked in
 * issue #8, see docs/curation/persona-catalogue-fit.md) — this schema exists
 * so adding personas 2-6 later is a data-only change, no code changes.
 */

export const PersonaWeightSchema = z.object({
  // A taxonomy node id (data/taxonomy.json). Personas are expected to weight
  // top-level nodes ("engineering") — src/curation/userInterests.ts's
  // resolver inherits a nested node's weight from its top-level ancestor, so
  // persona authors don't need to enumerate every nested node. Nested ids
  // are still valid here for a future persona that wants a specific
  // override (e.g. "engineering" broadly liked but "engineering/aerospace"
  // specifically not) — the schema supports it without a code change.
  node_id: z.string(),
  weight: z.number().min(-1).max(1)
});
export type PersonaWeight = z.infer<typeof PersonaWeightSchema>;

export const PersonaSchema = z.object({
  id: z.string().min(1),
  label: z.string().min(1),
  description: z.string().min(1),
  // Confidence assigned to every row this persona seeds into a user's
  // taxonomy_nodes table (src/curation/userInterests.ts). Deliberately low
  // relative to real observed signal (03_CURATION_SPEC.md's "Finished >=85%"
  // is a *strong* update) so real evidence quickly outweighs the prior —
  // this is what makes the seed "decaying" in practice without a separate
  // decay function. Tunable; not derived from data yet.
  seed_confidence: z.number().min(0).max(1),
  weights: z.array(PersonaWeightSchema)
});
export type Persona = z.infer<typeof PersonaSchema>;

export const PersonasFileSchema = z
  .object({
    version: z.literal(1),
    notes: z.string().optional(),
    default_persona_id: z.string(),
    personas: z.array(PersonaSchema)
  })
  .superRefine((file, ctx) => {
    const ids = file.personas.map((p) => p.id);
    const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
    if (dupes.length > 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate persona id(s): ${[...new Set(dupes)].join(", ")}` });
    }
    if (!ids.includes(file.default_persona_id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `default_persona_id "${file.default_persona_id}" does not match any persona id`
      });
    }
  });
export type PersonasFile = z.infer<typeof PersonasFileSchema>;
