import { z } from "zod";

/**
 * First-party behavioral event contract (personalization-and-depth-plan.md
 * Step C). Matches `backend/migrations/0009_events.sql`'s `type` check
 * constraint exactly — this module is the single source of truth for what a
 * valid event payload looks like on both the write path (client -> Supabase,
 * once the client wave lands) and the read path (the interest-learning job).
 *
 * Two deliberate contract decisions, both approved 2026-07-24 (see
 * docs/DECISIONS.md):
 *
 * 1. `episode_id`/`session_id` (the events table's uuid FK columns) are NOT
 *    populated by this contract. The client's real identifiers are catalogue
 *    slugs (`data/session.json` episode ids like "lex-353-whyte", session
 *    ids like "2026-07-08-morning"), not uuids matching the `episodes`/
 *    `sessions` tables (no live catalogue-ingest-to-Postgres pipeline exists
 *    yet). Durable identity travels in `payload.episode_slug` /
 *    `payload.session_key` instead; the uuid FK columns stay null until a
 *    real ingest pipeline exists to resolve them. Known, accepted gap — not
 *    fixed in this slice.
 * 2. `finished`/`skipped_at` payloads carry a `source` field distinguishing
 *    real observation from the web client's manual "Done ✓" stopgap
 *    (DECISIONS.md 2026-07-08: playback is external handoff, so Foray
 *    cannot observe web playback position). Principle #2 ("state observed,
 *    never declared") requires this provenance to be explicit rather than
 *    silently treating a declared click as observed behavior.
 */

export const EventTypeSchema = z.enum([
  "card_shown",
  "picked",
  "skipped_at",
  "finished",
  "voice_command",
  "thumbs",
  "saved",
  "session_built",
  "session_rated"
]);
export type EventType = z.infer<typeof EventTypeSchema>;

/** Menu slot provenance — matches session_items.archetype plus 'continue'. */
export const ArchetypeSlotSchema = z.enum(["deep-learn", "stretch", "narrative", "comfort", "continue"]);
export type ArchetypeSlot = z.infer<typeof ArchetypeSlotSchema>;

/** Shared denormalized episode context — see contract decision (1) above. */
const EpisodeContextSchema = z.object({
  episode_slug: z.string().min(1),
  show: z.string().optional(),
  topics: z.array(z.string()).default([])
});

export const CardShownPayloadSchema = EpisodeContextSchema.extend({
  archetype: ArchetypeSlotSchema
});
export type CardShownPayload = z.infer<typeof CardShownPayloadSchema>;

export const PickedPayloadSchema = EpisodeContextSchema.extend({
  archetype: ArchetypeSlotSchema,
  app: z.string().optional() // e.g. "Apple Podcasts" — where the deep link sent them
});
export type PickedPayload = z.infer<typeof PickedPayloadSchema>;

export const SkippedAtPayloadSchema = EpisodeContextSchema.extend({
  elapsed_seconds: z.number().nonnegative(),
  duration_seconds: z.number().positive().optional()
});
export type SkippedAtPayload = z.infer<typeof SkippedAtPayloadSchema>;

/** See contract decision (2): provenance is mandatory, never assumed observed. */
export const EventSourceSchema = z.enum(["observed", "manual_stopgap"]);
export type EventSource = z.infer<typeof EventSourceSchema>;

export const FinishedPayloadSchema = EpisodeContextSchema.extend({
  percent_complete: z.number().min(0).max(1),
  source: EventSourceSchema
});
export type FinishedPayload = z.infer<typeof FinishedPayloadSchema>;

export const VoiceCommandSchema = z.enum([
  "more_like_this",
  "something_different",
  "less_x",
  "never_this_show"
]);
export type VoiceCommand = z.infer<typeof VoiceCommandSchema>;

export const VoiceCommandPayloadSchema = z.object({
  command: VoiceCommandSchema,
  node_id: z.string().optional(),
  show: z.string().optional(),
  episode_slug: z.string().optional()
});
export type VoiceCommandPayload = z.infer<typeof VoiceCommandPayloadSchema>;

export const ThumbsPayloadSchema = z.object({
  direction: z.enum(["up", "down"]),
  node_id: z.string().min(1),
  episode_slug: z.string().optional()
});
export type ThumbsPayload = z.infer<typeof ThumbsPayloadSchema>;

export const SavedPayloadSchema = EpisodeContextSchema;
export type SavedPayload = z.infer<typeof SavedPayloadSchema>;

export const SessionBuiltPayloadSchema = z.object({
  session_key: z.string().min(1),
  builder: z.string()
});
export type SessionBuiltPayload = z.infer<typeof SessionBuiltPayloadSchema>;

export const SessionRatedPayloadSchema = z.object({
  session_key: z.string().min(1),
  rating: z.enum(["good", "meh", "bad"])
});
export type SessionRatedPayload = z.infer<typeof SessionRatedPayloadSchema>;

/**
 * The full discriminated union: (type, payload) pairs. Use this to validate
 * a candidate (type, payload) tuple before it is written anywhere.
 */
export const EventPayloadByTypeSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("card_shown"), payload: CardShownPayloadSchema }),
  z.object({ type: z.literal("picked"), payload: PickedPayloadSchema }),
  z.object({ type: z.literal("skipped_at"), payload: SkippedAtPayloadSchema }),
  z.object({ type: z.literal("finished"), payload: FinishedPayloadSchema }),
  z.object({ type: z.literal("voice_command"), payload: VoiceCommandPayloadSchema }),
  z.object({ type: z.literal("thumbs"), payload: ThumbsPayloadSchema }),
  z.object({ type: z.literal("saved"), payload: SavedPayloadSchema }),
  z.object({ type: z.literal("session_built"), payload: SessionBuiltPayloadSchema }),
  z.object({ type: z.literal("session_rated"), payload: SessionRatedPayloadSchema })
]);
export type EventPayloadByType = z.infer<typeof EventPayloadByTypeSchema>;

/**
 * A full events-table row as this contract knows it. `episode_id`/
 * `session_id` are always null on write per contract decision (1) — kept in
 * the schema (rather than omitted) so a future resolver pass can populate
 * them without a contract-shape change.
 */
export const EventRowSchema = z
  .object({
    id: z.string().uuid().optional(),
    user_id: z.string().uuid(),
    ts: z.string().datetime({ offset: true }).optional(),
    session_id: z.null().optional(),
    episode_id: z.null().optional(),
    archetype: z.string().nullable().optional()
  })
  .and(EventPayloadByTypeSchema);
export type EventRow = z.infer<typeof EventRowSchema>;

/** Parses and validates a candidate row; throws a ZodError with a readable path on failure. */
export function parseEventRow(input: unknown): EventRow {
  return EventRowSchema.parse(input);
}

/** Non-throwing variant for ingestion loops that must skip-and-warn rather than crash. */
export function safeParseEventRow(input: unknown): ReturnType<typeof EventRowSchema.safeParse> {
  return EventRowSchema.safeParse(input);
}
