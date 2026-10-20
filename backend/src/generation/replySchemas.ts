import { z, type ZodTypeAny } from "zod";
import type { ActWriteResult } from "./NarrationWriterBuilder";
import type { ActVerifyResult } from "./NarrationVerifierBuilder";
import type { IntentUnderstanding } from "../types/generation";
import { DURATION_SHAPE_BUDGETS, SHAPE_TOLERANCE, type DurationTier, type Spine } from "../types/spine";
import { zodToJsonSchema, type JsonSchema } from "./chat/jsonSchema";

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

/* GV-86 (W4-05): the folded-deepen spine reply, sent as its own json_schema
   ('spine_fold_deepen') only when SpineBuildContext.foldDeepen is set, so the
   classic 'spine' schema and grammar stay byte-identical. Each beat may carry
   `kind` (the deepen reply's enum) and each act its `introduction` and `exit`.
   All three are optional: a reply that leaves them out costs that act one
   deepen call (deepenActs.ts falls back), never the spine a re-ask. */
export const SpineFoldDeepenBeatSchema = SpineBeatSchema.extend({ kind: z.enum(["account", "argument"]).optional() });
export const SpineFoldDeepenSlotSchema = SpineSlotSchema.extend({ beats: z.array(SpineFoldDeepenBeatSchema) });
export const SpineFoldDeepenActSchema = SpineActSchema.extend({
  slots: z.array(SpineFoldDeepenSlotSchema),
  introduction: z.string().optional(),
  exit: z.string().optional()
});
export const RawSpineFoldDeepenSchema = RawSpineSchema.extend({ acts: z.array(SpineFoldDeepenActSchema) });

/* ---------- GV-100: the per-tier spine schema ---------- */

/** GV-100 (W4-04 item 2): the longest beat claim the per-tier grammar lets
 * through. One sentence of at most 25 words is the house shape; 420
 * characters is room for that with long proper names, not a target. */
export const SPINE_CLAIM_MAX_CHARS = 420;
/** GV-100: the longest folded title or summary the per-tier grammar lets
 * through (forayCopy clamps both at 18 words downstream). */
export const SPINE_COPY_TEXT_MAX_CHARS = 140;

/**
 * GV-100: the act counts a `tier` spine may carry, `[min, max]` inclusive:
 * DURATION_SHAPE_BUDGETS' act band widened by SHAPE_TOLERANCE, rounded
 * inward to whole acts, so it is exactly the set of counts validateSpine
 * accepts (short [1, 1], medium [3, 4], long [5, 8]).
 */
export function spineActBand(tier: DurationTier): [number, number] {
  const [min, max] = DURATION_SHAPE_BUDGETS[tier].acts;
  return [Math.ceil(min * (1 - SHAPE_TOLERANCE)), Math.floor(max * (1 + SHAPE_TOLERANCE))];
}

export interface SpineSchemaOptions {
  /** GV-86: the folded-deepen reply (RawSpineFoldDeepenSchema) instead of
   * the classic one. The folded copy fields are in both, so fold-copy does
   * not change the schema. */
  foldDeepen?: boolean;
}

/**
 * GV-100 (decision 11): the spine reply schema for one tier, as zod. It is
 * RawSpineSchema (or RawSpineFoldDeepenSchema) with the per-tier overrides
 * of W4-04 item 2 and nothing else: acts bounded by `spineActBand(tier)`,
 * every slot with at least one beat, each claim at most
 * SPINE_CLAIM_MAX_CHARS, the folded title and summary at most
 * SPINE_COPY_TEXT_MAX_CHARS. zod's `extend` keeps each overridden key where
 * it was, so the properties stay in contract order (the folded copy fields
 * first, then overview, voice, acts; seed and GV-86's kind, introduction and
 * exit where the base schema has them).
 *
 * It is what the grammar holds the reply to (`spineJsonSchema`); the reply
 * is still PARSED with the base schema, so a reply recorded before the
 * bounds, or from an unconstrained target, parses as it always did.
 */
export function spineTierReplySchema(tier: DurationTier, opts: SpineSchemaOptions = {}): z.ZodObject<z.ZodRawShape> {
  const [minActs, maxActs] = spineActBand(tier);
  const foldDeepen = opts.foldDeepen === true;
  const beat = (foldDeepen ? SpineFoldDeepenBeatSchema : SpineBeatSchema).extend({ claim: z.string().max(SPINE_CLAIM_MAX_CHARS) });
  const slot = SpineSlotSchema.extend({ beats: z.array(beat).min(1) });
  const act = (foldDeepen ? SpineFoldDeepenActSchema : SpineActSchema).extend({ slots: z.array(slot) });
  return (foldDeepen ? RawSpineFoldDeepenSchema : RawSpineSchema).extend({
    title: z.string().max(SPINE_COPY_TEXT_MAX_CHARS).optional(),
    summary: z.string().max(SPINE_COPY_TEXT_MAX_CHARS).optional(),
    acts: z.array(act).min(minActs).max(maxActs)
  }) as unknown as z.ZodObject<z.ZodRawShape>;
}

const spineJsonSchemaCache = new Map<string, JsonSchema>();

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

/**
 * GV-100 (decision 11; W4-04 item 2, W4-18): the per-tier spine JSON Schema
 * a ChatSpineBuilder sends as its json_schema response_format under
 * FORAY_SPINE_TIER_SIZING: zodToJsonSchema of `spineTierReplySchema(tier,
 * opts)`. Converted once per (tier, foldDeepen) and frozen, so every call
 * sends the same object (and SGLang compiles the same grammar).
 */
export function spineJsonSchema(tier: DurationTier, opts: SpineSchemaOptions = {}): JsonSchema {
  const key = `${tier}:${opts.foldDeepen === true ? "foldDeepen" : "classic"}`;
  const cached = spineJsonSchemaCache.get(key);
  if (cached) return cached;
  const schema = deepFreeze(zodToJsonSchema(spineTierReplySchema(tier, opts)));
  spineJsonSchemaCache.set(key, schema);
  return schema;
}

/**
 * GV-86: a folded-deepen act's introduction or exit that came back blank is
 * dropped here, so the act parses under ActSchema (where both are non-blank
 * when present) and deepenActs.ts falls back to a deepen call for it, rather
 * than the blank string failing the spine's schema and ending the run.
 * Returns `acts` itself when no act has a blank one, which a classic reply
 * (whose schema strips both fields) never has.
 */
function withoutBlankDeepenFields<A extends { introduction?: string; exit?: string }>(acts: A[]): A[] {
  const blank = (text: string | undefined): boolean => text !== undefined && text.trim() === "";
  if (!acts.some((act) => blank(act.introduction) || blank(act.exit))) return acts;
  return acts.map((act) => {
    if (!blank(act.introduction) && !blank(act.exit)) return act;
    const { introduction, exit, ...rest } = act;
    return { ...rest, ...(blank(introduction) ? {} : { introduction }), ...(blank(exit) ? {} : { exit }) } as A;
  });
}

/** A reply's acts as the Spine carries them: GV-86's blank deepen fields
 * dropped, otherwise the reply's own array. */
function replyActs(raw: z.infer<typeof RawSpineSchema> | z.infer<typeof RawSpineFoldDeepenSchema>): Spine["acts"] {
  return withoutBlankDeepenFields(raw.acts as z.infer<typeof SpineFoldDeepenActSchema>[]);
}

/** The copy fields a folded spine reply carries, in the order the prompt asks
 * for them (prompts/spine.ts) and the re-ask's assistant turn repeats them. */
export const SPINE_COPY_FIELDS = ["subject", "angle", "priorKnowledge", "disappointment", "answersDisappointment", "title", "summary"] as const;
type SpineCopyField = (typeof SPINE_COPY_FIELDS)[number];

/** The copy fields a folded reply carries onto the Spine only when it gave
 * them: every copy field but subject and angle, which every Spine has. */
const SPINE_CARRIED_COPY_FIELDS = SPINE_COPY_FIELDS.filter(
  (field): field is Exclude<SpineCopyField, "subject" | "angle"> => field !== "subject" && field !== "angle"
);

/**
 * GV-67: the copy fields a folded reply MUST carry, non-blank. On the folded
 * path no understander wrote a subject, angle, title or summary, and the only
 * thing left to fall back to is the pre-spine keyword list, which must never
 * be spoken (the prelude names the subject) or published (the title and
 * summary; forayCopy's fallback title is `subject: angle`). So a reply that
 * leaves one out or blank is a structural violation: `buildSpine.ts` re-asks
 * it with F-86's re-ask, naming the fields, and fails the stage when it is
 * still missing (`spineStructure.ts` foldedCopyIssues).
 */
export const SPINE_REQUIRED_COPY_FIELDS = ["subject", "angle", "title", "summary"] as const satisfies readonly SpineCopyField[];

/**
 * GV-67: the spine builders' one post-parse step, shared by
 * AnthropicSpineBuilder and its Chat twin so both hand the pipeline the same
 * Spine for the same reply.
 *
 * Classic (`folded` false): exactly the Spine the builders always returned,
 * subject and angle from the intent, no copy fields, whatever the reply said.
 *
 * Folded: subject and angle come from the reply and ONLY from it (the intent
 * is a keyword list then, never to be spoken): one the reply left out or
 * blank is "" here, which the structural gate refuses and re-asks
 * (SPINE_REQUIRED_COPY_FIELDS). priorKnowledge, disappointment,
 * answersDisappointment, title and summary are carried when the reply gave
 * them non-blank, so a spine that passes the gate always parses under
 * SpineSchema.
 *
 * Either way, a folded-deepen reply (GV-86, RawSpineFoldDeepenSchema) keeps
 * each act's introduction and exit and each beat's kind on the Spine's acts,
 * a blank introduction or exit dropped (withoutBlankDeepenFields).
 */
export function spineFromReply(
  raw: z.infer<typeof RawSpineSchema> | z.infer<typeof RawSpineFoldDeepenSchema>,
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
      acts: replyActs(raw)
    };
  }
  const said = (text: string | undefined): string | undefined => {
    const trimmed = text?.trim();
    return trimmed ? trimmed : undefined;
  };
  const copy: Partial<Pick<Spine, "priorKnowledge" | "disappointment" | "answersDisappointment" | "title" | "summary">> = {};
  for (const field of SPINE_CARRIED_COPY_FIELDS) {
    const value = said(raw[field]);
    if (value !== undefined) copy[field] = value;
  }
  return {
    subject: said(raw.subject) ?? "",
    angle: said(raw.angle) ?? "",
    overview: raw.overview,
    duration,
    generatedAt: new Date().toISOString(),
    voice: raw.voice,
    acts: replyActs(raw),
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
  | "spine_fold_deepen"
  | "deepen_act"
  | "continuity_smooth"
  | "act_write"
  | "act_verify";

export const REPLY_SCHEMAS: Readonly<Record<ReplySchemaName, ZodTypeAny>> = Object.freeze({
  clarity: ClaritySchema,
  intent: IntentSchema,
  title_recase: TitleRecaseSchema,
  spine: RawSpineSchema,
  spine_fold_deepen: RawSpineFoldDeepenSchema,
  deepen_act: RawDeepenedActSchema,
  continuity_smooth: RawSmoothResultSchema,
  act_write: RawActWriteSchema,
  act_verify: RawActVerifySchema
});

export const REPLY_SCHEMA_NAMES = Object.keys(REPLY_SCHEMAS) as ReplySchemaName[];
