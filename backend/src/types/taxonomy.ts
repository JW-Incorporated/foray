import { z } from "zod";

/** Matches data/taxonomy.json exactly (see docs/research/curation-practices.md sec. "Recommended taxonomy JSON schema"). */
export const TaxonomyNodeSchema = z.object({
  id: z.string(),
  parent: z.string().nullable(),
  label: z.string(),
  // Distinctive vocabulary for the topic resolver, added with F-59 (docs/curation/
  // generation-run-2026-09-09.md). OPTIONAL and rare: a node needs one only when its
  // label is too generic to distinguish it — `engineering/energy-fusion` ("Fusion &
  // energy systems") was winning AI/ML prompts on the word "systems" alone.
  terms: z.array(z.string()).optional(),
  // null = no Apple Podcasts category maps (the industry taxonomy has no
  // Engineering, no aviation/food/etc. subtypes — that gap is why the custom
  // tree exists; see docs/research/curation-practices.md)
  apple_anchor: z.string().nullable(),
  weight: z.number().min(-1).max(1),
  confidence: z.number().min(0).max(1),
  last_evidence_at: z.string()
});
export type TaxonomyNode = z.infer<typeof TaxonomyNodeSchema>;

export const TaxonomyFileSchema = z.object({
  version: z.literal(1),
  notes: z.string().optional(),
  nodes: z.array(TaxonomyNodeSchema),
  episode_attributes: z.object({
    depth: z.array(z.string()),
    format: z.array(z.string()),
    evergreen: z.string()
  })
});
export type TaxonomyFile = z.infer<typeof TaxonomyFileSchema>;
