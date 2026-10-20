import { describe, it, expect, vi, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { ChatSpineBuilder, readSpineTierSizing, SPINE_SHORTER_LINE, SPINE_TIER_SIZING_ENV } from "../src/generation/chat/ChatSpineBuilder";
import { targetFor } from "../src/generation/chat/targetFor";
import { responseFormatFor, type JsonSchema } from "../src/generation/chat/jsonSchema";
import { OpenAICompatChatProvider } from "../src/generation/chat/openAICompatProvider";
import type { ChatRequest } from "../src/generation/chat/ChatProvider";
import { toChatMessages } from "../src/generation/promptLayout";
import { buildSeedFloorInstruction, buildSpineFixInstruction, buildSpinePromptParts, spineReplyText } from "../src/generation/prompts/spine";
import {
  RawSpineFoldDeepenSchema,
  RawSpineSchema,
  SPINE_CLAIM_MAX_CHARS,
  spineActBand,
  spineJsonSchema,
  spineTierReplySchema
} from "../src/generation/replySchemas";
import { TruncatedReplyError } from "../src/generation/replyErrors";
import { BUILDER_MAX_TOKENS, OUTPUT_TOKEN_BUDGETS, SPINE_FOLD_EXTRA_TOKENS, spineMaxTokens } from "../src/config/outputBudgets";
import { DEFAULT_LANE_PROFILES } from "../src/config/machineProfiles";
import type { StageRoute } from "../src/config/stageRouting";
import { FlagValueError } from "../src/generation/generationFlags";
import { runForayPipeline, timedSpineSeedFloorReasks } from "../src/generation/runPipeline";
import { postSeedWithFloor } from "../src/generation/postSeedSpine";
import { DEFAULT_SEED_FLOOR_REASKS } from "../src/generation/postSeedSpine";
import { CLASSIC_PIPELINE_FLAGS, FAST_PATH_PIPELINE_FLAGS } from "../src/generation/pipelineFlags";
import { checkpointFingerprint } from "../src/generation/checkpoint";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { BudgetGuard } from "../src/cost/budgetGuard";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import type { CostEventInput } from "../src/cost/costEvents";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { PipelineFlags } from "../src/generation/pipelineFlags";
import type { GenerationRequest, IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";
import { validateSpine, type DurationTier } from "../src/types/spine";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import { scriptedProvider } from "./helpers/fakeChatProvider";
import { fakeFetch } from "./helpers/fakeFetch";

/* GV-100: postSeedWithFloor stays the real function; the spy only records
   the options runForayPipeline hands it (vi.mock is hoisted). */
vi.mock("../src/generation/postSeedSpine", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/generation/postSeedSpine")>();
  return { ...actual, postSeedWithFloor: vi.fn(actual.postSeedWithFloor) };
});

/**
 * GV-100 (docs/roadmap/generation-v2.md, from W4-04 items 2-4 and W4-18;
 * covers R1-03, R2-07, GP-02, GP-05): spine tier sizing on the Spark.
 *
 *   - spineJsonSchema(tier) (replySchemas.ts) is zodToJsonSchema of
 *     RawSpineSchema with the per-tier overrides; it accepts the short and
 *     medium fixture replies, refuses an act count outside the tier's band,
 *     and agrees with its zod twin and with RawSpineSchema on every fixture;
 *   - spineMaxTokens (config/outputBudgets.ts) is ceil((target + fold
 *     extras) x 1.5);
 *   - ChatSpineBuilder under FORAY_SPINE_TIER_SIZING sends that schema and
 *     cap, keeps the re-ask prefix, and answers one 'length' stop with one
 *     shorter re-ask; off, it sends exactly what it sent before;
 *   - runForayPipeline passes maxSeedFloorReasks 0 on the fast path's short
 *     tier, and nothing new anywhere else.
 *
 * Offline only: scriptedProvider replies, one fakeFetch replay of a synthetic
 * OpenAI body, Stub builders for the pipeline. The fixtures in
 * fixtures/local/ are SYNTHETIC (their _source says so); the live step
 * replaces them with recorded Spark replies. Each test names the mutation
 * that turns it red; every one was run.
 */

const FIXTURES = path.join(__dirname, "fixtures");

function completionBody(rel: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(FIXTURES, rel), "utf8")) as Record<string, unknown>;
}
function replyText(rel: string): string {
  return (completionBody(rel) as { choices: Array<{ message: { content: string } }> }).choices[0]!.message.content;
}

const SHORT = "local/spine-short-reply.json";
const MEDIUM = "local/spine-medium-reply.json";
/** GV-25's synthetic spine body: generation run 2's acts (4 acts). */
const RUN2 = "openai/spine-reply.json";

const shortReply = JSON.parse(replyText(SHORT)) as Record<string, unknown>;
const mediumReply = JSON.parse(replyText(MEDIUM)) as Record<string, unknown>;
const run2Reply = JSON.parse(replyText(RUN2)) as Record<string, unknown>;

/* ---------- a JSON Schema check for the subset zodToJsonSchema emits ---------- */

function typeOf(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value === "number" ? "number" : typeof value;
}

/** The first way `value` breaks `schema`, or null when it conforms. Covers
 * every keyword chat/jsonSchema.ts produces: type (or a type list), enum,
 * properties, required, additionalProperties false, items, min/maxItems and
 * min/maxLength. */
function jsonSchemaError(schema: JsonSchema, value: unknown, at = "$"): string | null {
  const types = Array.isArray(schema.type) ? schema.type : [schema.type];
  const actual = typeOf(value);
  if (!(types as string[]).includes(actual)) return `${at}: ${actual} is not ${types.join("|")}`;
  if (schema.enum && !schema.enum.includes(value as string | null)) return `${at}: not in enum`;
  if (actual === "string") {
    const s = value as string;
    if (schema.minLength !== undefined && s.length < schema.minLength) return `${at}: shorter than ${schema.minLength}`;
    if (schema.maxLength !== undefined && s.length > schema.maxLength) return `${at}: longer than ${schema.maxLength}`;
  }
  if (actual === "array") {
    const a = value as unknown[];
    if (schema.minItems !== undefined && a.length < schema.minItems) return `${at}: fewer than ${schema.minItems} items`;
    if (schema.maxItems !== undefined && a.length > schema.maxItems) return `${at}: more than ${schema.maxItems} items`;
    for (let i = 0; i < a.length; i++) {
      const e = schema.items ? jsonSchemaError(schema.items, a[i], `${at}[${i}]`) : null;
      if (e) return e;
    }
  }
  if (actual === "object") {
    const o = value as Record<string, unknown>;
    for (const key of schema.required ?? []) if (!(key in o)) return `${at}: missing ${key}`;
    for (const [key, child] of Object.entries(o)) {
      const prop = schema.properties?.[key];
      if (!prop) {
        if (schema.additionalProperties === false) return `${at}: extra property ${key}`;
        continue;
      }
      const e = jsonSchemaError(prop, child, `${at}.${key}`);
      if (e) return e;
    }
  }
  return null;
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
type RawActs = { acts: Array<{ slots: Array<{ beats: Array<{ claim: string }> }> }> };

/** Each fixture reply and variants of it that sit on either side of a bound.
 * No variant carries an unknown key: zod strips one, the grammar refuses it
 * (additionalProperties false), which the override test pins on its own. */
function variants(): Array<{ name: string; reply: Record<string, unknown> }> {
  const out: Array<{ name: string; reply: Record<string, unknown> }> = [
    { name: "short", reply: shortReply },
    { name: "medium", reply: mediumReply },
    { name: "run2", reply: run2Reply }
  ];
  const longClaim = clone(mediumReply) as unknown as RawActs;
  longClaim.acts[0]!.slots[0]!.beats[0]!.claim = "x".repeat(SPINE_CLAIM_MAX_CHARS + 1);
  out.push({ name: "medium, a claim one past the bound", reply: longClaim as unknown as Record<string, unknown> });
  const atBound = clone(mediumReply) as unknown as RawActs;
  atBound.acts[0]!.slots[0]!.beats[0]!.claim = "x".repeat(SPINE_CLAIM_MAX_CHARS);
  out.push({ name: "medium, a claim at the bound", reply: atBound as unknown as Record<string, unknown> });
  const emptySlot = clone(shortReply) as unknown as RawActs;
  emptySlot.acts[0]!.slots[0]!.beats = [];
  out.push({ name: "short, a slot with no beats", reply: emptySlot as unknown as Record<string, unknown> });
  const longTitle = { ...clone(shortReply), title: "t".repeat(141) };
  out.push({ name: "short, a 141-character title", reply: longTitle });
  const twoActs = clone(shortReply) as unknown as RawActs;
  twoActs.acts.push(clone(twoActs.acts[0]!));
  out.push({ name: "short, two acts", reply: twoActs as unknown as Record<string, unknown> });
  const fiveActs = clone(mediumReply) as unknown as RawActs;
  fiveActs.acts.push(clone(fiveActs.acts[0]!), clone(fiveActs.acts[1]!));
  out.push({ name: "medium, five acts", reply: fiveActs as unknown as Record<string, unknown> });
  return out;
}

const TIERS: DurationTier[] = ["short", "medium", "long"];

describe("spineJsonSchema: the per-tier spine schema (replySchemas.ts, decision 11)", () => {
  it("accepts the short and medium fixture replies on their own tier, and refuses an act count outside the band", () => {
    /* MUTATION THAT KILLS THIS: drop `.min(minActs).max(maxActs)` from
       spineTierReplySchema's acts (the short schema then accepts the
       3-act medium reply). Ran it: red. */
    expect(jsonSchemaError(spineJsonSchema("short"), shortReply)).toBeNull();
    expect(jsonSchemaError(spineJsonSchema("medium"), mediumReply)).toBeNull();
    expect(jsonSchemaError(spineJsonSchema("short"), mediumReply)).toBe("$.acts: more than 1 items");
    expect(jsonSchemaError(spineJsonSchema("medium"), shortReply)).toBe("$.acts: fewer than 3 items");
    expect(jsonSchemaError(spineJsonSchema("long"), mediumReply)).toBe("$.acts: fewer than 5 items");
    expect(spineJsonSchema("medium").properties?.acts).toMatchObject({ minItems: 3, maxItems: 4 });
  });

  it("agrees with its zod twin on every fixture and bound variant, and every fixture parses under RawSpineSchema", () => {
    /* MUTATION THAT KILLS THIS: in spineJsonSchema, convert RawSpineSchema
       instead of spineTierReplySchema(tier) (the JSON Schema then accepts
       what the zod twin refuses). Ran it: red. */
    const seen = { accepted: 0, refused: 0 };
    for (const tier of TIERS) {
      for (const foldDeepen of [false, true]) {
        const json = spineJsonSchema(tier, { foldDeepen });
        const zod = spineTierReplySchema(tier, { foldDeepen });
        for (const { name, reply } of variants()) {
          const jsonOk = jsonSchemaError(json, reply) === null;
          expect(zod.safeParse(reply).success, `${tier}${foldDeepen ? " foldDeepen" : ""}: ${name}`).toBe(jsonOk);
          seen[jsonOk ? "accepted" : "refused"] += 1;
        }
      }
    }
    expect(seen.accepted).toBeGreaterThan(0);
    expect(seen.refused).toBeGreaterThan(0);
    for (const reply of [shortReply, mediumReply, run2Reply]) {
      expect(RawSpineSchema.safeParse(reply).success).toBe(true);
      expect(RawSpineFoldDeepenSchema.safeParse(reply).success).toBe(true);
    }
    /* The run-2 spine has 4 acts: inside the medium tier's band. */
    expect(jsonSchemaError(spineJsonSchema("medium"), run2Reply)).toBeNull();
  });

  it("holds each per-tier override: a beat per slot, the claim and copy bounds, and nothing else stricter than RawSpineSchema", () => {
    /* MUTATION THAT KILLS THIS: drop `.min(1)` on the slot's beats (or
       SPINE_CLAIM_MAX_CHARS 420 -> 421). Ran both: red. */
    const byName = new Map(variants().map((v) => [v.name, v.reply]));
    const medium = spineJsonSchema("medium");
    const short = spineJsonSchema("short");
    expect(jsonSchemaError(medium, byName.get("medium, a claim at the bound"))).toBeNull();
    expect(jsonSchemaError(medium, byName.get("medium, a claim one past the bound"))).toMatch(/\.claim: longer than 420$/);
    expect(jsonSchemaError(short, byName.get("short, a slot with no beats"))).toBe("$.acts[0].slots[0].beats: fewer than 1 items");
    expect(jsonSchemaError(short, byName.get("short, a 141-character title"))).toBe("$.title: longer than 140");
    /* An unknown key: the grammar refuses it, the parser strips it. */
    const extra = { ...clone(shortReply), mood: "wistful" };
    expect(jsonSchemaError(short, extra)).toBe("$: extra property mood");
    expect(RawSpineSchema.safeParse(extra).success).toBe(true);
    /* Seed and the folded copy stay optional; the required lists are
       RawSpineSchema's. */
    const base = responseFormatFor("spine").schema;
    expect(short.required).toEqual(base.required);
    const beat = short.properties?.acts?.items?.properties?.slots?.items?.properties?.beats?.items;
    expect(beat?.required).toEqual(["claim", "exploration"]);
    expect(Object.keys(beat?.properties ?? {})).toEqual(["claim", "exploration", "seed"]);
  });

  it("keeps the properties in contract order, the fold fields of GV-67 and GV-86 included", () => {
    /* MUTATION THAT KILLS THIS: build the tier schema with
       `z.object({acts, ...RawSpineSchema.shape})` (acts first). Ran it: red. */
    const short = spineJsonSchema("short");
    expect(Object.keys(short.properties ?? {})).toEqual([
      "subject",
      "angle",
      "priorKnowledge",
      "disappointment",
      "answersDisappointment",
      "title",
      "summary",
      "overview",
      "voice",
      "acts"
    ]);
    const folded = spineJsonSchema("short", { foldDeepen: true });
    const act = folded.properties?.acts?.items;
    expect(Object.keys(act?.properties ?? {})).toEqual(["title", "thesis", "startState", "endState", "slots", "introduction", "exit"]);
    expect(Object.keys(act?.properties?.slots?.items?.properties?.beats?.items?.properties ?? {})).toEqual(["claim", "exploration", "seed", "kind"]);
    expect(folded.properties?.acts).toMatchObject({ minItems: 1, maxItems: 1 });
    /* Converted once and shared. */
    expect(spineJsonSchema("short")).toBe(short);
    expect(Object.isFrozen(short)).toBe(true);
  });

  it("spineActBand is exactly the act counts validateSpine accepts on each tier", () => {
    /* MUTATION THAT KILLS THIS: use Math.round instead of Math.floor for
       the band's top (long's 8.05 then still 8, but medium's 4.6 becomes 5).
       Ran it: red. */
    expect(TIERS.map(spineActBand)).toEqual([
      [1, 1],
      [3, 4],
      [5, 8]
    ]);
    const act = (mediumReply as unknown as { acts: unknown[] }).acts[0];
    for (const tier of TIERS) {
      const [lo, hi] = spineActBand(tier);
      for (let n = 0; n <= 10; n++) {
        const spine = { subject: "s", angle: "a", overview: "o", duration: tier, generatedAt: "x", voice: mediumReply.voice, acts: Array(n).fill(act) };
        const actIssue = validateSpine(spine as never).issues.some((i) => i.code === "act-count-out-of-budget");
        expect(!actIssue, `${tier} ${n} acts`).toBe(n >= lo && n <= hi);
      }
    }
  });
});

describe("spineMaxTokens: the tier-sized spine cap (outputBudgets.ts, decision 10)", () => {
  it("is ceil((target + fold extras) x 1.5): the documented table", () => {
    /* MUTATION THAT KILLS THIS: count the fold-deepen extra once per Foray
       instead of per act (or headroom 1.5 -> 1.25). Ran both: red. */
    expect(OUTPUT_TOKEN_BUDGETS.spine).toEqual({ short: 450, medium: 1200, long: 2400 });
    expect(SPINE_FOLD_EXTRA_TOKENS).toEqual({ copy: 120, perAct: 100 });
    const table = TIERS.map((tier) => [
      spineMaxTokens(tier),
      spineMaxTokens(tier, { foldCopy: true }),
      spineMaxTokens(tier, { foldDeepen: true }),
      spineMaxTokens(tier, { foldCopy: true, foldDeepen: true })
    ]);
    expect(table).toEqual([
      [675, 855, 825, 1005],
      [1800, 1980, 2400, 2580],
      [3600, 3780, 4800, 4980]
    ]);
    /* Every tier-sized cap is below the tier-blind one it replaces. */
    for (const row of table) for (const cap of row) expect(cap).toBeLessThan(BUILDER_MAX_TOKENS.spine);
  });
});

/* ---------- ChatSpineBuilder ---------- */

const sparkRoute: StageRoute = { provider: "local", lane: "spark", model: "local-heavy" };
const sparkTarget = targetFor(sparkRoute, DEFAULT_LANE_PROFILES.spark);
const ctx = { userId: "founder-1", sessionId: "s1" };

function recordingGuard() {
  const checks: CostEventInput[] = [];
  return { checks, guard: { checkAndRecord: async (input: CostEventInput) => void checks.push(input) } };
}

const shortIntent: IntentUnderstanding = {
  subject: "grilling",
  angle: "where charcoal comes from",
  priorKnowledge: "has grilled",
  disappointment: "grilling tips"
};
const mediumIntent: IntentUnderstanding = {
  subject: "lighthouses",
  angle: "how they rose and went dark",
  priorKnowledge: "has seen one",
  disappointment: "a list of famous lighthouses"
};

function shapeFor(intent: IntentUnderstanding): ResearchShape {
  return {
    subject: intent.subject,
    angle: intent.angle,
    generatedAt: "2026-10-20T00:00:00.000Z",
    subtopics: [
      {
        label: intent.subject,
        source: "literal-term",
        tape: { signal: "thin", itemCount: 2, showCount: 1, exampleItemIds: [] },
        controversies: [],
        externalNotes: null,
        externallyResearched: false,
        tapeWindows: [],
        windowsUnavailable: "no transcript text index in this fixture"
      }
    ],
    nonObviousAngle: null,
    externalGapsResearched: []
  };
}

const LISTENER_PROMPT = "where does charcoal actually come from";

function sized(provider: ReturnType<typeof scriptedProvider>, guard = recordingGuard().guard): ChatSpineBuilder {
  return new ChatSpineBuilder(provider, sparkTarget, guard, { tierSizing: true });
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("ChatSpineBuilder under tier sizing", () => {
  it("sends the tier's json_schema and spineMaxTokens, thinking off, and parses the short (folded) and medium fixtures into Spines that pass validateSpine", async () => {
    /* MUTATION THAT KILLS THIS: send spineMaxTokens(duration) without the
       fold options (the folded short call then asks for 675, not 855), or
       send responseFormatFor(schemaName) on the sized path. Ran both: red. */
    const provider = scriptedProvider({ complete: [replyText(SHORT), replyText(MEDIUM)] });
    const { checks, guard } = recordingGuard();
    const builder = sized(provider, guard);

    const short = await builder.buildSpine(shortIntent, shapeFor(shortIntent), "short", { ...ctx, listenerPrompt: LISTENER_PROMPT });
    const medium = await builder.buildSpine(mediumIntent, shapeFor(mediumIntent), "medium", ctx);

    const [shortReq, mediumReq] = provider.requests as [ChatRequest, ChatRequest];
    expect(shortReq.responseFormat).toEqual({ type: "json_schema", name: "spine", schema: spineJsonSchema("short"), strict: true });
    expect(shortReq.responseFormat).not.toEqual(responseFormatFor("spine"));
    expect(shortReq).toMatchObject({ maxTokens: 855, thinking: false, label: "spine", model: "local-heavy" });
    expect(mediumReq.responseFormat).toEqual({ type: "json_schema", name: "spine", schema: spineJsonSchema("medium"), strict: true });
    expect(mediumReq).toMatchObject({ maxTokens: spineMaxTokens("medium"), thinking: false });
    expect(mediumReq.maxTokens).toBe(1800);
    expect(mediumReq.messages).toEqual(toChatMessages(buildSpinePromptParts(mediumIntent, shapeFor(mediumIntent), "medium")));
    expect(checks).toEqual([
      expect.objectContaining({ operation: "spine_build", provider: "local:spark" }),
      expect.objectContaining({ operation: "spine_build", provider: "local:spark" })
    ]);

    expect(validateSpine(short)).toMatchObject({ valid: true, counts: { acts: 1, slots: 3, items: 9 } });
    expect(validateSpine(medium)).toMatchObject({ valid: true, counts: { acts: 3, slots: 6, items: 30 } });
    /* Folded: subject and angle from the reply; classic: from the intent. */
    expect(short).toMatchObject({ subject: "charcoal briquettes", title: "How Ford's scrap wood became the backyard grill", duration: "short" });
    expect(medium).toMatchObject({ subject: mediumIntent.subject, angle: mediumIntent.angle, duration: "medium" });
    expect(medium.acts[0]!.slots[0]!.beats[0]!.seed).toEqual({ episodeId: "ep-lighthouse-01", startSec: 120, endSec: 165 });
  });

  it("on the folded-deepen path sends the 'spine_fold_deepen' tier schema and counts the deepen extras", async () => {
    /* MUTATION THAT KILLS THIS: pass `{}` to spineJsonSchema on the sized
       path (the classic schema goes out). Ran it: red. */
    const provider = scriptedProvider({ complete: [replyText(SHORT)] });
    await sized(provider).buildSpine(shortIntent, shapeFor(shortIntent), "short", { ...ctx, listenerPrompt: LISTENER_PROMPT, foldDeepen: true });
    const req = provider.requests[0]!;
    expect(req.responseFormat).toEqual({ type: "json_schema", name: "spine_fold_deepen", schema: spineJsonSchema("short", { foldDeepen: true }), strict: true });
    expect(req.maxTokens).toBe(1005);
  });

  it("a structural and a seed-floor re-ask start with the identical system and first user turn, then the refused spine and the fix turn of their kind", async () => {
    /* MUTATION THAT KILLS THIS: on the sized path, rebuild the messages
       without spineRevisionTurns (the re-ask then sends the first call's
       turns only). Ran it: red. */
    const first = scriptedProvider({ complete: [replyText(MEDIUM)] });
    const previous = await sized(first).buildSpine(mediumIntent, shapeFor(mediumIntent), "medium", ctx);
    const opening = first.requests[0]!.messages;
    expect(opening.map((m) => m.role)).toEqual(["system", "user"]);

    const violations = ["act 1, slot 1: beat claim is 2 sentences, must be one"];
    const provider = scriptedProvider({ complete: [replyText(MEDIUM), replyText(MEDIUM)] });
    const builder = sized(provider);
    await builder.buildSpine(mediumIntent, shapeFor(mediumIntent), "medium", { ...ctx, revision: { previous, violations, attempt: 1 } });
    await builder.buildSpine(mediumIntent, shapeFor(mediumIntent), "medium", { ...ctx, revision: { previous, violations, attempt: 1, kind: "seed-floor" } });
    const [structural, seedFloor] = provider.requests as [ChatRequest, ChatRequest];
    expect(structural.messages).toEqual([
      ...opening,
      { role: "assistant", content: spineReplyText(previous) },
      { role: "user", content: buildSpineFixInstruction(violations) }
    ]);
    expect(seedFloor.messages).toEqual([
      ...opening,
      { role: "assistant", content: spineReplyText(previous) },
      { role: "user", content: buildSeedFloorInstruction(violations) }
    ]);
    for (const req of [structural, seedFloor]) {
      expect(req.maxTokens).toBe(1800);
      expect(req.responseFormat).toEqual(first.requests[0]!.responseFormat);
    }
  });

  it("a 'length' stop gets exactly one shorter re-ask with the same turns, schema and cap, and its reply is the spine", async () => {
    /* MUTATION THAT KILLS THIS: rethrow every TruncatedReplyError in
       askTierSized (no re-ask), or re-ask without SPINE_SHORTER_LINE. Ran
       both: red. */
    const reply = replyText(SHORT);
    const provider = scriptedProvider({ complete: [{ text: reply.slice(0, 700), finishReason: "length" }, reply] });
    const { checks, guard } = recordingGuard();
    const spine = await sized(provider, guard).buildSpine(shortIntent, shapeFor(shortIntent), "short", ctx);

    expect(provider.requests).toHaveLength(2);
    const [cut, shorter] = provider.requests as [ChatRequest, ChatRequest];
    expect(shorter.messages).toEqual([...cut.messages, { role: "user", content: SPINE_SHORTER_LINE }]);
    expect(SPINE_SHORTER_LINE).toBe("Shorter: keep every beat one sentence of at most 25 words");
    expect(shorter.responseFormat).toEqual(cut.responseFormat);
    expect(shorter.maxTokens).toBe(cut.maxTokens);
    expect(cut.maxTokens).toBe(675);
    expect(checks).toHaveLength(2);
    expect(validateSpine(spine).valid).toBe(true);
  });

  it("a second 'length' stop throws TruncatedReplyError after exactly two calls", async () => {
    /* MUTATION THAT KILLS THIS: loop the shorter re-ask while the reply is
       cut (a third call is then made, and the script runs out with a plain
       Error instead). Ran it: red. */
    const reply = replyText(SHORT);
    const provider = scriptedProvider({
      complete: [
        { text: reply.slice(0, 700), finishReason: "length" },
        { text: reply.slice(0, 650), finishReason: "length" },
        reply
      ]
    });
    await expect(sized(provider).buildSpine(shortIntent, shapeFor(shortIntent), "short", ctx)).rejects.toBeInstanceOf(TruncatedReplyError);
    expect(provider.requests).toHaveLength(2);
  });

  it("any other failure is not re-asked shorter", async () => {
    /* MUTATION THAT KILLS THIS: catch every error in askTierSized (an HTTP
       failure is then re-asked). Ran it: red. */
    const provider = scriptedProvider({ complete: [new Error("http_503"), replyText(SHORT)] });
    await expect(sized(provider).buildSpine(shortIntent, shapeFor(shortIntent), "short", ctx)).rejects.toThrow("http_503");
    expect(provider.requests).toHaveLength(1);
  });

  it("is off by default: the request is the pre-GV-100 one (the 'spine' schema, cap 8000), and a 'length' stop still throws after one call", async () => {
    /* MUTATION THAT KILLS THIS: default readSpineTierSizing to true. Ran it:
       red. */
    vi.stubEnv(SPINE_TIER_SIZING_ENV, "0");
    delete process.env[SPINE_TIER_SIZING_ENV];
    const provider = scriptedProvider({ complete: [replyText(MEDIUM), { text: replyText(SHORT).slice(0, 700), finishReason: "length" }] });
    const builder = new ChatSpineBuilder(provider, sparkTarget, recordingGuard().guard);
    await builder.buildSpine(mediumIntent, shapeFor(mediumIntent), "medium", ctx);
    expect(provider.requests[0]!.responseFormat).toBe(responseFormatFor("spine"));
    expect(provider.requests[0]!.maxTokens).toBe(BUILDER_MAX_TOKENS.spine);
    await expect(builder.buildSpine(shortIntent, shapeFor(shortIntent), "short", ctx)).rejects.toBeInstanceOf(TruncatedReplyError);
    expect(provider.requests).toHaveLength(2);
  });

  it("FORAY_SPINE_TIER_SIZING turns it on at call time, the constructor option wins over it, and a malformed value names the variable", async () => {
    /* MUTATION THAT KILLS THIS: read the flag once in the constructor (the
       stubbed env set after construction is then ignored). Ran it: red. */
    const provider = scriptedProvider({ complete: [replyText(MEDIUM), replyText(MEDIUM)] });
    const fromEnv = new ChatSpineBuilder(provider, sparkTarget, recordingGuard().guard);
    vi.stubEnv(SPINE_TIER_SIZING_ENV, "1");
    await fromEnv.buildSpine(mediumIntent, shapeFor(mediumIntent), "medium", ctx);
    expect(provider.requests[0]!.maxTokens).toBe(1800);
    await new ChatSpineBuilder(provider, sparkTarget, recordingGuard().guard, { tierSizing: false }).buildSpine(mediumIntent, shapeFor(mediumIntent), "medium", ctx);
    expect(provider.requests[1]!.maxTokens).toBe(BUILDER_MAX_TOKENS.spine);
    expect(readSpineTierSizing({})).toBe(false);
    expect(() => readSpineTierSizing({ [SPINE_TIER_SIZING_ENV]: "sometimes" })).toThrow(FlagValueError);
    expect(() => readSpineTierSizing({ [SPINE_TIER_SIZING_ENV]: "sometimes" })).toThrow(SPINE_TIER_SIZING_ENV);
  });

  it("over the real OpenAI-compatible client, the wire body carries the medium tier's json_schema, max_tokens 1800 and thinking off", async () => {
    /* MUTATION THAT KILLS THIS: in askStructured, ignore input.responseFormat
       (responseFormatFor('spine') then reaches the wire). Ran it: red. */
    const fake = fakeFetch({ body: completionBody(MEDIUM) });
    const provider = new OpenAICompatChatProvider({ baseUrl: "http://litellm.invalid:4000", apiKey: "test-key", fetchImpl: fake.fetch });
    const spine = await new ChatSpineBuilder(provider, sparkTarget, recordingGuard().guard, { tierSizing: true }).buildSpine(
      mediumIntent,
      shapeFor(mediumIntent),
      "medium",
      ctx
    );
    expect(validateSpine(spine).valid).toBe(true);
    expect(fake.calls).toHaveLength(1);
    const body = fake.calls[0]!.body as {
      response_format: { type: string; json_schema: { name: string; schema: unknown; strict: boolean } };
      max_tokens: number;
      chat_template_kwargs: unknown;
    };
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema).toEqual({ name: "spine", schema: spineJsonSchema("medium"), strict: true });
    expect(body.max_tokens).toBe(1800);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
  });

  it("imports no Anthropic SDK and no Anthropic call module (ChatSpineBuilder.ts, replySchemas.ts)", () => {
    /* MUTATION THAT KILLS THIS: import BUILDER_MAX_TOKENS via
       "../AnthropicSpineBuilder" in ChatSpineBuilder.ts. Ran it: red. */
    for (const rel of ["chat/ChatSpineBuilder.ts", "replySchemas.ts"]) {
      const src = fs.readFileSync(path.join(__dirname, "..", "src", "generation", rel), "utf8");
      expect(src, rel).not.toMatch(/@anthropic-ai\/sdk/);
      expect(src, rel).not.toMatch(/from "[./]*\/?(?:anthropicCall|Anthropic\w*)"/);
    }
  });
});

/* ---------- the seed-floor re-ask off the short timed path ---------- */

describe("timedSpineSeedFloorReasks and runForayPipeline (W4-04 item 4)", () => {
  it("is the timed-path value on the fast path's short tier only", () => {
    /* MUTATION THAT KILLS THIS: drop `duration === "short"` (medium on the
       fast path then loses its floor re-ask too). Ran it: red. */
    expect(timedSpineSeedFloorReasks(FAST_PATH_PIPELINE_FLAGS, "short")).toBe(0);
    expect(timedSpineSeedFloorReasks(FAST_PATH_PIPELINE_FLAGS, "medium")).toBeUndefined();
    expect(timedSpineSeedFloorReasks(FAST_PATH_PIPELINE_FLAGS, "long")).toBeUndefined();
    expect(timedSpineSeedFloorReasks(CLASSIC_PIPELINE_FLAGS, "short")).toBeUndefined();
    expect(timedSpineSeedFloorReasks({ fastPath: true, spineSeedFloorReasksOnTimedPath: 2 }, "short")).toBe(2);
    expect(DEFAULT_SEED_FLOOR_REASKS).toBe(1);
  });

  const finalize = async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
    ({
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: input.id, generated: true } as never,
      timings: []
    }) as unknown as FinalizeForayResult;

  class StopAfterSeedFloor extends Error {}

  /** Runs the pipeline up to postSeedWithFloor and returns the options it
   * was handed (the spy then stops the run). */
  async function seedFloorOptions(duration: DurationTier, flags: Partial<PipelineFlags>, spineSeedFloorReasks?: number) {
    const spy = vi.mocked(postSeedWithFloor);
    spy.mockClear();
    spy.mockImplementationOnce(async () => {
      throw new StopAfterSeedFloor("stop");
    });
    const request: GenerationRequest = { prompt: "the history of grilling and barbecue", duration, author_id: "founder-1", visibility: "catalogue" };
    const topic = "food/grilling-bbq";
    const key = `gv100-${duration}-${JSON.stringify(flags)}-${spineSeedFloorReasks ?? "none"}`;
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration, topic }));
    const guard = new BudgetGuard(new InMemoryCostEventSink(), 100);
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    try {
      await expect(
        runForayPipeline(
          request,
          {
            userId: "founder-1",
            now: () => new Date("2026-10-20T08:00:00.000Z"),
            topic,
            checkpointKey: key,
            flags,
            ...(spineSeedFloorReasks !== undefined ? { spineSeedFloorReasks } : {})
          },
          {
            understander: new StubPromptUnderstander(),
            researcher: new StubExternalResearcher(),
            spineBuilder: new StubSpineBuilder(guard),
            deepenBuilder: new StubDeepenActBuilder(),
            narrationWriter: new StubNarrationWriterBuilder(),
            narrationVerifier: new StubNarrationVerifierBuilder(),
            continuityBuilder: new StubContinuityBuilder(),
            finalize,
            checkpoint: store
          }
        )
      ).rejects.toBeInstanceOf(StopAfterSeedFloor);
    } finally {
      log.mockRestore();
    }
    expect(spy).toHaveBeenCalledTimes(1);
    return spy.mock.calls[0]![6]!;
  }

  it("on the fast path's short tier postSeedWithFloor is handed maxSeedFloorReasks 0; classic short and fast-path medium are handed none", async () => {
    /* MUTATION THAT KILLS THIS: in runPipeline, keep passing
       options.spineSeedFloorReasks alone (the fast-path short run then hands
       none). Ran it: red. */
    const fastShort = await seedFloorOptions("short", { fastPath: true });
    expect(fastShort.maxSeedFloorReasks).toBe(0);
    expect(typeof fastShort.onReask).toBe("function");

    const classicShort = await seedFloorOptions("short", {});
    expect("maxSeedFloorReasks" in classicShort).toBe(false);
    const fastMedium = await seedFloorOptions("medium", { fastPath: true });
    expect("maxSeedFloorReasks" in fastMedium).toBe(false);
  });

  it("an explicit spineSeedFloorReasks still wins on the fast path", async () => {
    /* MUTATION THAT KILLS THIS: put timedSpineSeedFloorReasks first in the
       `??` (the explicit 1 is then replaced by 0). Ran it: red. */
    const explicit = await seedFloorOptions("short", { fastPath: true }, 1);
    expect(explicit.maxSeedFloorReasks).toBe(1);
  });
});
