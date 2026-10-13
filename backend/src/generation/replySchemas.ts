import { z, type ZodTypeAny } from "zod";
import type { ActWriteResult } from "./NarrationWriterBuilder";
import type { ActVerifyResult } from "./NarrationVerifierBuilder";
import type { IntentUnderstanding } from "../types/generation";
import type { DurationTier, Spine } from "../types/spine";

/**
 * Every JSON reply schema the generation builders parse a model's answer
 * with, in one module (GV-02, docs/roadmap/generation-v2.md; decision 11:
 * reply schemas live only here).
 *
 * They moved here UNCHANGED from the Anthropic builders, which import them
 * back, so the Anthropic path parses exactly as before. The point of the
 * move is that a second consumer can see them: `chat/jsonSchema.ts` turns
 * each one into a JSON Schema for a grammar-constrained local model
 * (SGLang's json_schema, llama.cpp), and the Chat builders parse the same
 * reply with the same zod schema.
 *
 * The researcher's ResearchSchema and PassagesSchema stay in their own
 * module: research is not routed to a local model.
 *
 * Constructs used here are limited to what `zodToJsonSchema` converts:
 * object, array, string, number, boolean, enum, optional, nullable and
 * length bounds. A union, transform, refinement, record or default makes
 * the converter throw, and the jsonSchema suite turns that red.
 */

/* ---------- prompt understanding (AnthropicPromptUnderstander) ---------- */

export const ClaritySchema = z.object({
  ambiguous: z.boolean(),
  readings: z.array(z.string()).max(3),
  question: z.string().nullable()
});

export const IntentSchema = z.object({
  subject: z.string(),
  angle: z.string(),
  priorKnowledge: z.string(),
  disappointment: z.string(),
  /* F-64 — see `IntentUnderstandingSchema`. Optional here too: a model that
     drops them costs a clamped fallback, not a re-ask. */
  title: z.string().optional(),
  summary: z.string().optional()
});

/** The one-field reply to the sentence-case title re-ask. */
export const TitleRecaseSchema = z.object({ title: z.string() });

/* ---------- spine (AnthropicSpineBuilder) ---------- */

/* `seed` is optional and passed through: WS-L asks for at least
   `SPINE_MIN_SEEDED_BEATS_PER_ACT` beats per act written from a quoted
   transcript window, and the seed is how the beat says which one. A missing or
   malformed seed must not cost the whole spine a re-ask — `spineStructure.ts`
   is what enforces the floor, with a message that says what to fix. */
export const BeatSeedSchema = z.object({ episodeId: z.string(), startSec: z.number(), endSec: z.number() });
export const SpineBeatSchema = z.object({ claim: z.string(), exploration: z.boolean(), seed: BeatSeedSchema.optional() });
export const SpineSlotSchema = z.object({ title: z.string(), beats: z.array(SpineBeatSchema) });
export const SpineActSchema = z.object({
  title: z.string(),
  thesis: z.string(),
  startState: z.string(),
  endState: z.string(),
  slots: z.array(SpineSlotSchema)
});
export const VoiceSchema = z.object({
  style: z.string(),
  register: z.string(),
  sentenceRhythm: z.string(),
  narratorPresence: z.string()
});
/* GV-67 (W4-03): on the folded path the spine reply also carries the listener
   copy the understander used to write (subject, angle, priorKnowledge,
   disappointment, answersDisappointment, title, summary), asked for first.
   Optional, so a classic reply (and every reply recorded before them) parses
   exactly as before; `spineFromReply` reads them only on a folded call. */
export const RawSpineSchema = z.object({
  subject: z.string().optional(),
  angle: z.string().optional(),
  priorKnowledge: z.string().optional(),
  disappointment: z.string().optional(),
  answersDisappointment: z.string().optional(),
  title: z.string().optional(),
  summary: z.string().optional(),
  overview: z.string(),
  voice: VoiceSchema,
  acts: z.array(SpineActSchema)
});

/** The copy fields a folded spine reply carries, in the order the prompt asks
 * for them (prompts/spine.ts) and the re-ask's assistant turn repeats them. */
export const SPINE_COPY_FIELDS = ["subject", "angle", "priorKnowledge", "disappointment", "answersDisappointment", "title", "summary"] as const;

/**
 * GV-67: the spine builders' one post-parse step, shared by
 * AnthropicSpineBuilder and its Chat twin so both hand the pipeline the same
 * Spine for the same reply.
 *
 * Classic (`folded` false): exactly the Spine the builders always returned,
 * subject and angle from the intent, no copy fields, whatever the reply said.
 *
 * Folded: subject and angle come from the reply (the intent is only a keyword
 * list then), falling back to the intent's only when the reply left them out
 * or blank; priorKnowledge, disappointment, answersDisappointment, title and
 * summary are carried when the reply gave them non-blank, so a banked spine
 * always parses under SpineSchema.
 */
export function spineFromReply(
  raw: z.infer<typeof RawSpineSchema>,
  intent: IntentUnderstanding,
  duration: DurationTier,
  folded: boolean
): Spine {
  if (!folded) {
    return {
      subject: intent.subject,
      angle: intent.angle,
      overview: raw.overview,
      duration,
      generatedAt: new Date().toISOString(),
      voice: raw.voice,
      acts: raw.acts
    };
  }
  const said = (text: string | undefined): string | undefined => {
    const trimmed = text?.trim();
    return trimmed ? trimmed : undefined;
  };
  const copy: Partial<Pick<Spine, "priorKnowledge" | "disappointment" | "answersDisappointment" | "title" | "summary">> = {};
  for (const field of ["priorKnowledge", "disappointment", "answersDisappointment", "title", "summary"] as const) {
    const value = said(raw[field]);
    if (value !== undefined) copy[field] = value;
  }
  return {
    subject: said(raw.subject) ?? intent.subject,
    angle: said(raw.angle) ?? intent.angle,
    overview: raw.overview,
    duration,
    generatedAt: new Date().toISOString(),
    voice: raw.voice,
    acts: raw.acts,
    ...copy
  };
}

/* ---------- act deepening (AnthropicDeepenActBuilder) ---------- */

/* `kind` is optional here and defaulted downstream rather than required: a
   model that omits it must not cost the whole act a retry, and an absent kind
   means "account", which is the search-for-tape behaviour that predates the
   field (see BeatKindSchema in types/spine.ts). */
/* `seed` (WS-L, F-63) is parsed rather than dropped: a beat the spine wrote from
   a quoted transcript window names that window, and §4.5 opens the named episode
   first. It is optional here for the same reason `kind` is — a model that omits
   it must not cost the act a retry — and `deepenActs.ts` puts back any seed the
   reply lost, so the pass-through is guaranteed in code rather than asked for in
   a prompt.

   F-68 EXTENDS THAT TO THE CLAIM. A seeded beat's `claim` is frozen: the prompt
   says to copy it verbatim, and `deepenActs.ts` restores it when the model
   paraphrased anyway. A paraphrase parses fine here on purpose — it must not
   cost the act a retry — it simply does not survive the stage. */
export const DeepenBeatSchema = z.object({
  claim: z.string(),
  exploration: z.boolean(),
  kind: z.enum(["account", "argument"]).optional(),
  seed: BeatSeedSchema.optional()
});
export const DeepenSlotSchema = z.object({ title: z.string(), beats: z.array(DeepenBeatSchema) });
export const RawDeepenedActSchema = z.object({
  title: z.string(),
  thesis: z.string(),
  startState: z.string(),
  endState: z.string(),
  slots: z.array(DeepenSlotSchema),
  introduction: z.string(),
  exit: z.string()
});

/* ---------- continuity (AnthropicContinuityBuilder) ---------- */

export const RawSmoothResultSchema = z.object({
  nextIntroduction: z.string()
});

/* ---------- narration writer (AnthropicNarrationWriterBuilder) ---------- */

export const RawClaimSchema = z.object({
  claimText: z.string(),
  quote: z.string(),
  docId: z.string(),
  contested: z.boolean()
});

export const RawWrittenSeamSchema = z.object({
  seamId: z.string(),
  script: z.string(),
  claims: z.array(RawClaimSchema),
  usedClaims: z.array(z.number()),
  pronunciationHints: z.array(z.object({ word: z.string(), hint: z.string() })).optional()
});

export const RawActWriteSchema = z.object({ seams: z.array(RawWrittenSeamSchema) });

/**
 * GV-43 (W4-09, docs/roadmap/generation-v2.md): ONE SEAM PER LINE. The
 * streamed writer reply is JSONL -- one seam object per line, in listening
 * order -- so `seamStream.ts`'s JsonlSeamParser can hand each seam on the
 * moment its line closes instead of waiting for the whole act's JSON.
 *
 * The line variant differs from RawWrittenSeamSchema in one way: every
 * field is REQUIRED, pronunciationHints included (R2-08's condition). In
 * the whole-act reply a missing pronunciationHints is defaulted to [] by
 * toActWriteResult; on a line there is no post-parse step, so the line
 * says it outright and the parser's seam is a WrittenSeam as parsed.
 */
export const RawWrittenSeamLineSchema = RawWrittenSeamSchema.extend({
  pronunciationHints: z.array(z.object({ word: z.string(), hint: z.string() }))
});

/**
 * GV-31: the writer's one post-parse step, shared by the Anthropic writer
 * and its Chat twin so both hand writeAct.ts the same ActWriteResult for the
 * same reply. A seam that named no pronunciation hints gets [] (the field is
 * optional in the schema so a reply without it is still valid).
 */
export function toActWriteResult(raw: z.infer<typeof RawActWriteSchema>): ActWriteResult {
  return { seams: raw.seams.map((s) => ({ ...s, pronunciationHints: s.pronunciationHints ?? [] })) };
}

/* ---------- narration verifier (AnthropicNarrationVerifierBuilder) ---------- */

/* Q-03: one verdict per beat and one per seam of a whole act. F-97: each
 * names what it rests on (`restsOn`, ids of the act's source set) and a
 * carried beat names its carrier. Optional in the SCHEMA so a reply that
 * omits them is still valid JSON; `writeAct.ts` reads an absent `restsOn`
 * as "the seam's own claims" and refuses a declarative seam that rests on
 * nothing either way. */
export const RawActVerifySchema = z.object({
  beats: z.array(
    z.object({
      beatId: z.string(),
      carried: z.boolean(),
      carriedBy: z.string().optional(),
      restsOn: z.array(z.string()).optional(),
      notes: z.string().optional()
    })
  ),
  seams: z.array(
    z.object({
      seamId: z.string(),
      claimsSupported: z.boolean(),
      restsOn: z.array(z.string()).optional(),
      contestedHandled: z.boolean(),
      notes: z.string().optional()
    })
  )
});

/**
 * GV-31: the verifier's one post-parse step, shared by the Anthropic
 * verifier and its Chat twin. A seam verdict that named nothing it rests on
 * gets [] (writeAct.ts then reads it as "the seam's own claims"); the beat
 * verdicts pass through as parsed.
 */
export function toActVerifyResult(raw: z.infer<typeof RawActVerifySchema>): ActVerifyResult {
  return { beats: raw.beats, seams: raw.seams.map((s) => ({ ...s, restsOn: s.restsOn ?? [] })) };
}

/* ---------- the registry ---------- */

/** One name per top-level reply a builder parses. The name is also the
 * `name` a json_schema response_format carries, so it keeps to
 * [a-z_] (OpenAI-compatible servers restrict it to [a-zA-Z0-9_-]). */
export type ReplySchemaName =
  | "clarity"
  | "intent"
  | "title_recase"
  | "spine"
  | "deepen_act"
  | "continuity_smooth"
  | "act_write"
  | "act_verify";

export const REPLY_SCHEMAS: Readonly<Record<ReplySchemaName, ZodTypeAny>> = Object.freeze({
  clarity: ClaritySchema,
  intent: IntentSchema,
  title_recase: TitleRecaseSchema,
  spine: RawSpineSchema,
  deepen_act: RawDeepenedActSchema,
  continuity_smooth: RawSmoothResultSchema,
  act_write: RawActWriteSchema,
  act_verify: RawActVerifySchema
});

export const REPLY_SCHEMA_NAMES = Object.keys(REPLY_SCHEMAS) as ReplySchemaName[];
