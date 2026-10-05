import { z } from "zod";

/**
 * Matches data/session.json exactly (version 1). This is the contract the
 * iOS client already codes against — the session builder CLI must emit
 * documents that validate against this schema byte-shape-for-byte-shape
 * (field names, nesting), even though our own DB layer is richer.
 */

export const ArchetypeSchema = z.enum(["deep-learn", "stretch", "narrative", "comfort"]);
export type Archetype = z.infer<typeof ArchetypeSchema>;

/**
 * Why a card was picked, machine-readably (#72, REQUIREMENTS-DELTA R17).
 * Full spec: docs/curation/session-doc-v1.md#provenance.
 *
 * `signals` lists what actually drove the pick — if the ranker used it, it is
 * listed; if it did not, it is not. Each signal is one of a closed grammar, so
 * a placeholder ("n/a", "ranked", "") cannot validate:
 *   topic:<taxonomy node id>   a data/taxonomy.json node the pick matched
 *   persona:<persona id>       a data/personas.json persona weighted that match
 *   pool:<archetype>           the archetype pool the pick was ranked within
 *   depth:<low|medium|high>    the episode's depth fed the quality term
 *   recency                    freshness beat an undated episode's neutral 0.5
 *   fatigue                    a same-show repetition penalty applied
 * Whether a topic/persona id is REAL is checked against the data files by
 * backend/test/sessionDoc.test.ts (the schema has no file access).
 */
export const ProvenanceSignalSchema = z
  .string()
  .regex(
    /^(topic:[a-z0-9-]+(\/[a-z0-9-]+)?|persona:[a-z0-9-]+|pool:(deep-learn|stretch|narrative|comfort)|depth:(low|medium|high)|recency|fatigue)$/,
    "not a provenance signal (see docs/curation/session-doc-v1.md#provenance)"
  );

export const ProvenanceSchema = z
  .object({
    signals: z.array(ProvenanceSignalSchema).min(1),
    // Required on stretch cards (enforced on SessionCardSchema below): CLAUDE.md
    // copy rule "Stretch picks must state their bridge", made machine-readable.
    bridge: z.string().trim().min(1).optional(),
    // The exploration-floor pick (~30%), flagged so it can be labelled honestly.
    wildcard: z.boolean(),
    // Same value as the session doc's top-level `builder` (R1).
    builder: z.string().min(1)
  })
  .strict();
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const SessionCardSchema = z
  .object({
    slot: z.number().int().min(1),
    archetype: ArchetypeSchema,
    archetype_label: z.string(),
    episode_id: z.string(),
    why_line: z.string(),
    fit_line: z.string(),
    alternates: z.array(z.string()),
    provenance: ProvenanceSchema
  })
  .superRefine((card, ctx) => {
    if (card.archetype === "stretch" && card.provenance.bridge === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["provenance", "bridge"],
        message: "a stretch card must state its bridge (CLAUDE.md copy rule 4; #72)"
      });
    }
  });
export type SessionCard = z.infer<typeof SessionCardSchema>;

export const SessionCategoryGroupSchema = z.object({
  label: z.string(),
  episode_ids: z.array(z.string())
});

export const SessionCategorySchema = z.object({
  id: z.string(),
  label: z.string(),
  description: z.string(),
  groups: z.array(SessionCategoryGroupSchema)
});
export type SessionCategory = z.infer<typeof SessionCategorySchema>;

export const SessionEpisodeDetailSchema = z
  .object({
    show: z.string(),
    title: z.string(),
    release_date: z.string(),
    duration_min: z.number(),
    apple_collection_id: z.number().nullable().optional(),
    apple_track_id: z.number().nullable().optional(),
    summary: z.string(),
    depth: z.enum(["low", "medium", "high"]),
    format: z.string(),
    topics: z.array(z.string())
  })
  // real-world episode extras like reactor_types (see data/session.json) are
  // allowed through untouched — the schema pins the *required* v1 shape.
  .passthrough();
export type SessionEpisodeDetail = z.infer<typeof SessionEpisodeDetailSchema>;

export const SessionDocSchema = z
  .object({
    version: z.literal(1),
    session_id: z.string(),
    // Which builder produced this session — the client stamps it into every
    // event, powering the blind hand-vs-machine test (REQUIREMENTS-DELTA R1).
    builder: z.string(),
    built_at: z.string(),
    commute: z.object({
      minutes: z.number(),
      playback_speed: z.number(),
      content_minutes: z.number()
    }),
    cards: z.array(SessionCardSchema),
    categories: z.array(SessionCategorySchema),
    episodes: z.record(SessionEpisodeDetailSchema)
  })
  .superRefine((doc, ctx) => {
    // #72: "builder — already exists in the session doc per R1's
    // infrastructure; keep it consistent here." One session, one builder.
    doc.cards.forEach((card, i) => {
      if (card.provenance.builder !== doc.builder) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["cards", i, "provenance", "builder"],
          message: `card provenance.builder "${card.provenance.builder}" differs from the session's builder "${doc.builder}"`
        });
      }
    });
  });
export type SessionDoc = z.infer<typeof SessionDocSchema>;
