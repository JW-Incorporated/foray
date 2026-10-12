import fs from "node:fs";
import path from "node:path";
import { describe, it, expect } from "vitest";
import { z } from "zod";
import {
  REPLY_SCHEMAS,
  REPLY_SCHEMA_NAMES,
  RawActVerifySchema,
  RawActWriteSchema,
  RawDeepenedActSchema,
  RawSpineSchema,
  type ReplySchemaName
} from "../src/generation/replySchemas";
import { UnsupportedZodError, responseFormatFor, zodToJsonSchema, type JsonSchema } from "../src/generation/chat/jsonSchema";

/* GV-02 (docs/roadmap/generation-v2.md): the reply schemas live in one module
 * and convert to JSON Schema for grammar-constrained local output. */

/** A minimal JSON Schema walker over exactly the keywords the converter
 * emits. Returns every violation, so a sample that does not fit says why. */
function violations(schema: JsonSchema, value: unknown, at = "$"): string[] {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual =
    value === null ? "null" : Array.isArray(value) ? "array" : typeof value === "object" ? "object" : typeof value;
  if (!types.includes(actual as never)) return [`${at}: ${actual} is not ${types.join("|")}`];
  const out: string[] = [];
  if (schema.enum && !schema.enum.includes(value as string | null)) out.push(`${at}: ${String(value)} is not in the enum`);
  if (actual === "string") {
    const s = value as string;
    if (schema.minLength !== undefined && s.length < schema.minLength) out.push(`${at}: shorter than ${schema.minLength}`);
    if (schema.maxLength !== undefined && s.length > schema.maxLength) out.push(`${at}: longer than ${schema.maxLength}`);
  }
  if (actual === "array") {
    const a = value as unknown[];
    if (schema.minItems !== undefined && a.length < schema.minItems) out.push(`${at}: fewer than ${schema.minItems} items`);
    if (schema.maxItems !== undefined && a.length > schema.maxItems) out.push(`${at}: more than ${schema.maxItems} items`);
    if (schema.items) a.forEach((item, i) => out.push(...violations(schema.items as JsonSchema, item, `${at}[${i}]`)));
  }
  if (actual === "object") {
    const o = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in o)) out.push(`${at}.${key}: required`);
    for (const [key, child] of Object.entries(o)) {
      const sub = schema.properties?.[key];
      if (!sub) {
        if (schema.additionalProperties === false) out.push(`${at}.${key}: not allowed`);
        continue;
      }
      out.push(...violations(sub, child, `${at}.${key}`));
    }
  }
  return out;
}

/** Every object node of a JSON Schema, with its path. */
function objectNodes(schema: JsonSchema, at = "$"): Array<{ at: string; node: JsonSchema }> {
  const out: Array<{ at: string; node: JsonSchema }> = [];
  if (schema.properties) {
    out.push({ at, node: schema });
    for (const [key, child] of Object.entries(schema.properties)) out.push(...objectNodes(child, `${at}.${key}`));
  }
  if (schema.items) out.push(...objectNodes(schema.items, `${at}[]`));
  return out;
}

const deepenFixture = JSON.parse(
  fs.readFileSync(path.join(__dirname, "fixtures", "run2-deepen-2026-09-09.json"), "utf8")
) as { acts: Array<Record<string, unknown> & { slots: Array<{ title: string; beats: Array<{ claim: string; exploration: boolean }> }> }> };

/* One realistic reply per schema. The deepen and spine replies come from the
 * recorded run-2 deepen fixture; the rest are the shapes the builder suites
 * fake (AnthropicPromptUnderstander.test.ts, actNarration.test.ts). */
const SAMPLES: Record<ReplySchemaName, unknown> = {
  clarity: { ambiguous: true, readings: ["planet", "element"], question: "Which Mercury?" },
  intent: {
    subject: "AI systems",
    angle: "the engineering",
    priorKnowledge: "has used a chatbot",
    disappointment: "no discussion of data pipelines",
    title: "Why most of a model is plumbing",
    summary: "Why most of a model is plumbing."
  },
  title_recase: { title: "Why most of a model is plumbing" },
  spine: {
    overview: "From the notebook to the pager.",
    voice: { style: "plain", register: "conversational", sentenceRhythm: "short, then long", narratorPresence: "light" },
    acts: deepenFixture.acts.map((act, a) => ({
      title: act.title,
      thesis: act.thesis,
      startState: act.startState,
      endState: act.endState,
      slots: act.slots.map((slot, s) => ({
        title: slot.title,
        beats: slot.beats.map((beat, b) => ({
          claim: beat.claim,
          exploration: beat.exploration,
          ...(a === 0 && s === 0 && b === 0 ? { seed: { episodeId: "ep-1", startSec: 12.5, endSec: 40 } } : {})
        }))
      }))
    }))
  },
  deepen_act: deepenFixture.acts[0],
  continuity_smooth: { nextIntroduction: "Which brings us to the pager." },
  act_write: {
    seams: [
      {
        seamId: "s0",
        script: "Most of the work happens before the model.",
        claims: [{ claimText: "Data work dominates.", quote: "most of my week is data", docId: "k0", contested: false }],
        usedClaims: [0],
        pronunciationHints: [{ word: "Kubeflow", hint: "KOOB-flow" }]
      },
      { seamId: "s1", script: "Listen to what he says next.", claims: [], usedClaims: [] }
    ]
  },
  act_verify: {
    beats: [
      { beatId: "b0", carried: true, carriedBy: "s0", restsOn: ["k0"] },
      { beatId: "b1", carried: false, notes: "no seam carries it" }
    ],
    seams: [
      { seamId: "s0", claimsSupported: true, restsOn: ["k0"], contestedHandled: true },
      { seamId: "s1", claimsSupported: false, contestedHandled: true, notes: "rests on no source in the act" }
    ]
  }
};

describe("replySchemas registry", () => {
  it("names every reply a builder parses, and the builders' schemas are the registry's", () => {
    expect(REPLY_SCHEMA_NAMES).toEqual([
      "clarity",
      "intent",
      "title_recase",
      "spine",
      "deepen_act",
      "continuity_smooth",
      "act_write",
      "act_verify"
    ]);
    expect(REPLY_SCHEMAS.spine).toBe(RawSpineSchema);
    expect(REPLY_SCHEMAS.deepen_act).toBe(RawDeepenedActSchema);
    expect(REPLY_SCHEMAS.act_write).toBe(RawActWriteSchema);
    expect(REPLY_SCHEMAS.act_verify).toBe(RawActVerifySchema);
  });

  it("the builders import their reply schemas from replySchemas.ts and define none of their own", () => {
    const dir = path.join(__dirname, "..", "src", "generation");
    for (const file of [
      "AnthropicPromptUnderstander.ts",
      "AnthropicSpineBuilder.ts",
      "AnthropicDeepenActBuilder.ts",
      "AnthropicContinuityBuilder.ts",
      "AnthropicNarrationWriterBuilder.ts",
      "AnthropicNarrationVerifierBuilder.ts"
    ]) {
      const src = fs.readFileSync(path.join(dir, file), "utf8");
      expect(src, file).toMatch(/from "\.\/replySchemas"/);
      expect(src, file).not.toMatch(/z\.object\(/);
    }
  });
});

describe("zodToJsonSchema over REPLY_SCHEMAS", () => {
  it("converts every reply schema, each pinned by its own snapshot", () => {
    for (const name of REPLY_SCHEMA_NAMES) expect(zodToJsonSchema(REPLY_SCHEMAS[name])).toMatchSnapshot(name);
  });

  it("gives every object additionalProperties:false and a required list", () => {
    for (const name of REPLY_SCHEMA_NAMES) {
      const nodes = objectNodes(zodToJsonSchema(REPLY_SCHEMAS[name]));
      expect(nodes.length, name).toBeGreaterThan(0);
      for (const { at, node } of nodes) {
        expect(node.additionalProperties, `${name} ${at}`).toBe(false);
        expect(Array.isArray(node.required), `${name} ${at}`).toBe(true);
      }
    }
  });

  it("leaves optional fields out of required and keeps them as properties", () => {
    const intent = zodToJsonSchema(REPLY_SCHEMAS.intent);
    expect(intent.required).toEqual(["subject", "angle", "priorKnowledge", "disappointment"]);
    expect(Object.keys(intent.properties ?? {})).toEqual(["subject", "angle", "priorKnowledge", "disappointment", "title", "summary"]);
    const deepenBeat = zodToJsonSchema(REPLY_SCHEMAS.deepen_act).properties?.slots?.items?.properties?.beats?.items;
    expect(deepenBeat?.required).toEqual(["claim", "exploration"]);
    expect(deepenBeat?.properties?.kind).toEqual({ type: "string", enum: ["account", "argument"] });
  });

  it("lets a nullable field be null and bounds clarity's readings at three", () => {
    const clarity = zodToJsonSchema(REPLY_SCHEMAS.clarity);
    expect(clarity.properties?.question).toEqual({ type: ["string", "null"] });
    expect(clarity.properties?.readings).toEqual({ type: "array", items: { type: "string" }, maxItems: 3 });
    expect(violations(clarity, { ambiguous: false, readings: [], question: null })).toEqual([]);
    expect(violations(clarity, { ambiguous: true, readings: ["a", "b", "c", "d"], question: "q" })).toEqual(["$.readings: more than 3 items"]);
  });

  it("parses a sample reply for every schema with zod, and the same reply fits the generated JSON Schema", () => {
    for (const name of REPLY_SCHEMA_NAMES) {
      const sample = SAMPLES[name];
      expect(REPLY_SCHEMAS[name].safeParse(sample).success, name).toBe(true);
      expect(violations(zodToJsonSchema(REPLY_SCHEMAS[name]), sample), name).toEqual([]);
    }
  });

  it("the walker is not vacuous: a reply zod refuses also fails the JSON Schema", () => {
    const spine = zodToJsonSchema(REPLY_SCHEMAS.spine);
    const extraField = { ...(SAMPLES.spine as object), bonus: 1 };
    const missingVoice = { overview: "o", acts: [] };
    const badKind = { ...(SAMPLES.deepen_act as object), slots: [{ title: "t", beats: [{ claim: "c", exploration: false, kind: "story" }] }] };
    expect(violations(spine, extraField)).toEqual(["$.bonus: not allowed"]);
    expect(violations(spine, missingVoice)).toEqual(["$.voice: required"]);
    expect(RawDeepenedActSchema.safeParse(badKind).success).toBe(false);
    expect(violations(zodToJsonSchema(REPLY_SCHEMAS.deepen_act), badKind)).toEqual(["$.slots[0].beats[0].kind: story is not in the enum"]);
  });
});

describe("zodToJsonSchema refuses what it cannot express", () => {
  function refusal(schema: z.ZodTypeAny): UnsupportedZodError {
    try {
      zodToJsonSchema(schema);
    } catch (error) {
      expect(error).toBeInstanceOf(UnsupportedZodError);
      return error as UnsupportedZodError;
    }
    throw new Error("zodToJsonSchema did not throw");
  }

  it("throws UnsupportedZodError naming the field path for a union", () => {
    const err = refusal(z.object({ acts: z.array(z.object({ score: z.union([z.string(), z.number()]) })) }));
    expect(err.path).toBe("$.acts[].score");
    expect(err.message).toContain("ZodUnion at $.acts[].score");
  });

  it("throws UnsupportedZodError naming the field path for a transform", () => {
    const err = refusal(z.object({ voice: z.object({ style: z.string().transform((s) => s.trim()) }) }));
    expect(err.path).toBe("$.voice.style");
    expect(err.message).toContain("ZodEffects (transform) at $.voice.style");
  });

  it("throws for record, default, an optional outside an object, and a string format check", () => {
    expect(refusal(z.object({ m: z.record(z.string()) })).path).toBe("$.m");
    expect(refusal(z.object({ d: z.string().default("x") })).construct).toBe("ZodDefault");
    expect(refusal(z.array(z.string().optional())).path).toBe("$[]");
    expect(refusal(z.object({ u: z.string().url() })).construct).toBe('ZodString check "url"');
  });

  it("maps string and array length bounds", () => {
    expect(zodToJsonSchema(z.string().min(2).max(140))).toEqual({ type: "string", minLength: 2, maxLength: 140 });
    expect(zodToJsonSchema(z.array(z.boolean()).min(1).max(7))).toEqual({ type: "array", items: { type: "boolean" }, minItems: 1, maxItems: 7 });
    expect(zodToJsonSchema(z.enum(["a", "b"]).nullable())).toEqual({ type: ["string", "null"], enum: ["a", "b", null] });
  });
});

describe("responseFormatFor", () => {
  it("returns a strict json_schema response_format named for the reply, cached and frozen", () => {
    const format = responseFormatFor("clarity");
    expect(format).toEqual({ type: "json_schema", name: "clarity", schema: zodToJsonSchema(REPLY_SCHEMAS.clarity), strict: true });
    expect(responseFormatFor("clarity")).toBe(format);
    expect(Object.isFrozen(format.schema.properties?.readings)).toBe(true);
    for (const name of REPLY_SCHEMA_NAMES) expect(responseFormatFor(name).name).toBe(name);
  });
});
