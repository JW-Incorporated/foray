import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { ChatPromptUnderstander } from "../src/generation/chat/ChatPromptUnderstander";
import { ChatSpineBuilder } from "../src/generation/chat/ChatSpineBuilder";
import { ChatDeepenActBuilder } from "../src/generation/chat/ChatDeepenActBuilder";
import { ChatContinuityBuilder } from "../src/generation/chat/ChatContinuityBuilder";
import { targetFor } from "../src/generation/chat/targetFor";
import { REASK_LINE, type StructuredTarget } from "../src/generation/chat/askStructured";
import { responseFormatFor } from "../src/generation/chat/jsonSchema";
import { OpenAICompatChatProvider } from "../src/generation/chat/openAICompatProvider";
import { AnthropicPromptUnderstander } from "../src/generation/AnthropicPromptUnderstander";
import { AnthropicSpineBuilder } from "../src/generation/AnthropicSpineBuilder";
import { AnthropicDeepenActBuilder } from "../src/generation/AnthropicDeepenActBuilder";
import { AnthropicContinuityBuilder } from "../src/generation/AnthropicContinuityBuilder";
import { joinParts, toChatMessages } from "../src/generation/promptLayout";
import { buildClarityPromptParts, buildIntentPromptParts } from "../src/generation/prompts/understand";
import { buildSeedFloorInstruction, buildSpineFixInstruction, buildSpinePromptParts, spineReplyText } from "../src/generation/prompts/spine";
import { buildDeepenActPromptParts } from "../src/generation/prompts/deepen";
import { buildSmoothPromptParts } from "../src/generation/prompts/continuity";
import { TruncatedReplyError } from "../src/generation/replyErrors";
import { DEFAULT_LANE_PROFILES } from "../src/config/machineProfiles";
import { BUILDER_MAX_TOKENS } from "../src/config/outputBudgets";
import type { StageRoute } from "../src/config/stageRouting";
import type { CostEventInput } from "../src/cost/costEvents";
import type { IntentUnderstanding } from "../src/types/generation";
import type { ResearchShape } from "../src/types/research";
import type { DeepenedAct, Spine } from "../src/types/spine";
import type { ContinuitySmoothRequest } from "../src/generation/ContinuityBuilder";
import { scriptedProvider, type ScriptedReply } from "./helpers/fakeChatProvider";
import { fakeFetch, openAIFixture } from "./helpers/fakeFetch";
import { textBlock } from "./helpers/fakeAnthropicClient";

/**
 * GV-25 (docs/roadmap/generation-v2.md, from W2-06; covers R2-21, GP-06,
 * HW-12, R1-18): the Chat twins of the four planning builders. Offline only:
 * scriptedProvider replies, one fakeFetch replay of a synthetic OpenAI body,
 * and the Anthropic twins on an injected fake client. No network, no model,
 * no key. Each test names the mutation that turns it red; every one was run.
 */

const FIXTURES = path.join(__dirname, "fixtures");

/** The content string of a committed synthetic OpenAI chat.completion. */
function replyContent(name: string): string {
  const body = openAIFixture(name) as { choices: Array<{ message: { content: string } }> };
  return body.choices[0]!.message.content;
}

const run2 = JSON.parse(fs.readFileSync(path.join(FIXTURES, "run2-deepen-2026-09-09.json"), "utf8")) as {
  subject: string;
  angle: string;
  acts: DeepenedAct[];
};

const ctx = { userId: "founder-1", sessionId: "s1" };

const sparkRoute: StageRoute = { provider: "local", lane: "spark", model: "local-heavy" };
const secondRoute: StageRoute = { provider: "local", lane: "second", model: "local-worker" };
const sparkTarget = targetFor(sparkRoute, DEFAULT_LANE_PROFILES.spark);
const secondTarget = targetFor(secondRoute, DEFAULT_LANE_PROFILES.second);

/** A guard that records every check it is asked for and never refuses. */
function recordingGuard() {
  const checks: CostEventInput[] = [];
  return { checks, guard: { checkAndRecord: async (input: CostEventInput) => void checks.push(input) } };
}

/** An Anthropic fake that answers each messages.create with the next text, in order. */
function sequentialAnthropic(...texts: string[]) {
  const create = vi.fn();
  for (const text of texts) create.mockResolvedValueOnce({ content: [textBlock(text)], stop_reason: "end_turn" });
  return { client: { messages: { create } } as unknown as Anthropic, create };
}

/** A guard for the Anthropic twins: they meter too, and must never be refused here. */
const anthropicGuard = { checkAndRecord: async () => undefined } as never;

const intent: IntentUnderstanding = {
  subject: run2.subject,
  angle: run2.angle,
  priorKnowledge: "knows models are trained on data",
  disappointment: "a tour of model architectures with no operations in it"
};

const researchShape: ResearchShape = {
  subject: intent.subject,
  angle: intent.angle,
  generatedAt: "2026-10-12T00:00:00.000Z",
  subtopics: [
    {
      label: "data pipelines",
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

/** run 2's deepened acts as a frozen spine (the deepen stage's input). */
const fullSpine: Spine = {
  subject: run2.subject,
  angle: run2.angle,
  overview: "How production machine learning actually gets built.",
  duration: "medium",
  generatedAt: "2026-09-09T00:00:00.000Z",
  voice: { style: "plain", register: "conversational", sentenceRhythm: "short", narratorPresence: "light" },
  acts: run2.acts.map((a) => ({ title: a.title, thesis: a.thesis, startState: a.startState, endState: a.endState, slots: a.slots }))
};

const FIXED_NOW = new Date("2026-10-12T08:00:00.000Z");

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(FIXED_NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("targetFor: a local route and its lane profile make the StructuredTarget", () => {
  it("names the provider local:<lane>, sends the route's model with the lane's structured output and rates, and carries thinking/temperature only when the route sets them", () => {
    /* MUTATION THAT KILLS THIS: drop the `thinking` spread in targetFor (or
       always send `temperature: 0`). Ran both: red. */
    expect(sparkTarget).toEqual({
      providerName: "local:spark",
      model: "local-heavy",
      structuredOutput: "json_schema",
      usdPerMtokIn: 0,
      usdPerMtokOut: 0
    });
    expect(secondTarget.providerName).toBe("local:second");
    expect(secondTarget.model).toBe("local-worker");
    const tuned = targetFor({ ...sparkRoute, thinking: true, temperature: 0.3 }, { ...DEFAULT_LANE_PROFILES.spark, structuredOutput: "json_object" });
    expect(tuned).toMatchObject({ thinking: true, temperature: 0.3, structuredOutput: "json_object" });
  });

  it("refuses a route that is not local, names no lane, or names another lane than the profile's", () => {
    /* MUTATION THAT KILLS THIS: delete the lane-mismatch check (a spark
       route on the second box's profile would then build). Ran it: red. */
    expect(() => targetFor({ provider: "anthropic", model: "claude-x", tier: "opus" }, DEFAULT_LANE_PROFILES.spark)).toThrow(/'local' route only/);
    expect(() => targetFor({ provider: "local", model: "local-heavy" }, DEFAULT_LANE_PROFILES.spark)).toThrow(/names no lane/);
    expect(() => targetFor(sparkRoute, DEFAULT_LANE_PROFILES.second)).toThrow(/not the profile's lane/);
  });
});

describe("ChatPromptUnderstander: clarity and intent on a ChatProvider", () => {
  it("clarity: returns what the Anthropic twin returns for the same reply, asking with the same prompt, the 'clarity' schema, cap 400 and thinking off", async () => {
    /* MUTATION THAT KILLS THIS: send BUILDER_MAX_TOKENS.intent in
       assessClarity (or schemaName 'intent'). Ran both: red. */
    const reply = '{"ambiguous": true, "readings": ["the planet", "the element"], "question": "The planet or the element?"}';
    const provider = scriptedProvider({ complete: [reply] });
    const { checks, guard } = recordingGuard();
    const chat = new ChatPromptUnderstander(provider, sparkTarget, guard);
    const { client } = sequentialAnthropic(reply);
    const anthropic = new AnthropicPromptUnderstander(anthropicGuard, client);

    const got = await chat.assessClarity("Mercury", ctx);
    expect(got).toEqual(await anthropic.assessClarity("Mercury", ctx));
    expect(chat.providerName).toBe("local:spark");
    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.responseFormat).toBe(responseFormatFor("clarity"));
    expect(req).toMatchObject({ model: "local-heavy", maxTokens: BUILDER_MAX_TOKENS.clarity, thinking: false, label: "prompt-understand" });
    /* GV-32: the chat path sends the prompt split, [system: stable, user: the listener's prompt]. */
    expect(req.messages).toEqual(toChatMessages(buildClarityPromptParts("Mercury")));
    expect(checks).toEqual([expect.objectContaining({ operation: "prompt_clarity", provider: "local:spark", model: "local-heavy", userId: "founder-1", sessionId: "s1" })]);
  });

  it("intent + title re-case: the Title Case title goes back once as the same 3-turn conversation the Anthropic twin sends, and both keep the same re-cased intent", async () => {
    /* MUTATION THAT KILLS THIS: in ChatPromptUnderstander's title ask, send
       only the corrective line (`[messages[2]]`) instead of `messages`.
       Ran it: red. */
    const intentReply = JSON.stringify({ ...intent, title: "How AI Actually Gets Built", summary: "What it takes to run a model in production." });
    const titleReply = '{"title": "How AI actually gets built"}';
    const provider = scriptedProvider({ complete: [intentReply, titleReply] });
    const chat = new ChatPromptUnderstander(provider, sparkTarget, recordingGuard().guard);
    const { client, create } = sequentialAnthropic(intentReply, titleReply);
    const anthropic = new AnthropicPromptUnderstander(anthropicGuard, client);

    const got = await chat.extractIntent("how AI gets built", ctx);
    expect(got).toEqual(await anthropic.extractIntent("how AI gets built", ctx));
    expect(got.title).toBe("How AI actually gets built");

    expect(provider.requests).toHaveLength(2);
    const [first, second] = provider.requests;
    expect(first!.responseFormat).toBe(responseFormatFor("intent"));
    expect(first!).toMatchObject({ maxTokens: BUILDER_MAX_TOKENS.intent, thinking: false });
    expect(first!.messages).toEqual(toChatMessages(buildIntentPromptParts("how AI gets built")));
    expect(second!.responseFormat).toBe(responseFormatFor("title_recase"));
    expect(second!).toMatchObject({ maxTokens: BUILDER_MAX_TOKENS.title, thinking: false });
    const anthropicTitleCall = create.mock.calls[1]![0] as { messages: unknown; max_tokens: number };
    /* GV-32: the same conversation, except that the chat path opens with the
       intent prompt split [system, user] exactly as its intent call did,
       where the Anthropic twin sends the joined prompt as one user turn. */
    const anthropicTurns = anthropicTitleCall.messages as Array<{ role: string; content: string }>;
    expect(anthropicTurns[0]).toEqual({ role: "user", content: joinParts(buildIntentPromptParts("how AI gets built")) });
    expect(second!.messages).toEqual([...first!.messages, ...anthropicTurns.slice(1)]);
    expect(second!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "user"]);
    expect(anthropicTitleCall.max_tokens).toBe(BUILDER_MAX_TOKENS.title);
  });

  it("a failed title re-ask keeps the first title, as the Anthropic twin does", async () => {
    /* MUTATION THAT KILLS THIS: remove the try/catch around `ask` in
       recaseIntentTitle (the failure then costs the whole intent). Ran it: red. */
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const intentReply = JSON.stringify({ ...intent, title: "How AI Actually Gets Built" });
    const provider = scriptedProvider({ complete: [intentReply, new Error("http_503")] });
    const chat = new ChatPromptUnderstander(provider, sparkTarget, recordingGuard().guard);
    const got = await chat.extractIntent("how AI gets built", ctx);
    expect(got.title).toBe("How AI Actually Gets Built");
    expect(provider.requests).toHaveLength(2);
    expect(warn.mock.calls.flat().join(" ")).toMatch(/ChatPromptUnderstander: the title re-ask .* failed \(http_503\); keeping it/);
    warn.mockRestore();
  });
});

describe("ChatSpineBuilder: the spine on a ChatProvider", () => {
  it("returns the Spine the Anthropic twin returns for the same reply (subject, angle, duration, generatedAt included), asking with the 'spine' schema, cap 8000 and thinking off", async () => {
    /* MUTATION THAT KILLS THIS: return `duration: "medium"` (or drop
       `overview`) in ChatSpineBuilder. Ran both: red. */
    const reply = replyContent("spine-reply");
    const provider = scriptedProvider({ complete: [reply] });
    const { checks, guard } = recordingGuard();
    const chat = new ChatSpineBuilder(provider, sparkTarget, guard);
    const { client } = sequentialAnthropic(reply);
    const anthropic = new AnthropicSpineBuilder(anthropicGuard, client);

    const got = await chat.buildSpine(intent, researchShape, "long", ctx);
    expect(got).toEqual(await anthropic.buildSpine(intent, researchShape, "long", ctx));
    expect(got).toMatchObject({ subject: intent.subject, angle: intent.angle, duration: "long", generatedAt: FIXED_NOW.toISOString() });
    expect(got.acts).toHaveLength(run2.acts.length);
    const req = provider.requests[0]!;
    expect(req.responseFormat).toBe(responseFormatFor("spine"));
    expect(req).toMatchObject({ maxTokens: BUILDER_MAX_TOKENS.spine, thinking: false, label: "spine", model: "local-heavy" });
    expect(req.messages).toEqual(toChatMessages(buildSpinePromptParts(intent, researchShape, "long")));
    expect(checks).toEqual([expect.objectContaining({ operation: "spine_build", provider: "local:spark" })]);
  });

  it("a structural re-ask sends [prompt, previous spine, fix instruction] in that order, the same conversation the Anthropic twin sends", async () => {
    /* MUTATION THAT KILLS THIS: in ChatSpineBuilder, send
       `[{ role: "user", content: promptText }]` and ignore ctx.revision.
       Ran it: red. */
    const reply = replyContent("spine-reply");
    const previous = await new ChatSpineBuilder(scriptedProvider({ complete: [reply] }), sparkTarget, recordingGuard().guard).buildSpine(intent, researchShape, "medium", ctx);
    const revision = { previous, violations: ["act 1, slot 1: beat claim is 2 sentences, must be one"], attempt: 1 };
    const provider = scriptedProvider({ complete: [reply] });
    await new ChatSpineBuilder(provider, sparkTarget, recordingGuard().guard).buildSpine(intent, researchShape, "medium", { ...ctx, revision });
    const { client, create } = sequentialAnthropic(reply);
    await new AnthropicSpineBuilder(anthropicGuard, client).buildSpine(intent, researchShape, "medium", { ...ctx, revision });

    const sent = provider.requests[0]!.messages;
    const parts = buildSpinePromptParts(intent, researchShape, "medium");
    expect(sent).toEqual([
      ...toChatMessages(parts),
      { role: "assistant", content: spineReplyText(previous) },
      { role: "user", content: buildSpineFixInstruction(revision.violations) }
    ]);
    /* GV-32: the Anthropic twin opens with the joined prompt as one user
       turn; the re-ask turns that follow are the same. */
    const anthropicSent = (create.mock.calls[0]![0] as { messages: Array<{ role: string; content: string }> }).messages;
    expect(anthropicSent[0]).toEqual({ role: "user", content: joinParts(parts) });
    expect(sent.slice(2)).toEqual(anthropicSent.slice(1));
  });

  it("the seed-floor re-ask uses buildSeedFloorInstruction for its fix turn", async () => {
    /* MUTATION THAT KILLS THIS: in spineConversation, use
       buildSpineFixInstruction for every revision kind. Ran it: red. */
    const reply = replyContent("spine-reply");
    const previous = await new ChatSpineBuilder(scriptedProvider({ complete: [reply] }), sparkTarget, recordingGuard().guard).buildSpine(intent, researchShape, "medium", ctx);
    const violations = ['act 1, slot 1, "The model is a small component": closest window [ep1 10-40s]'];
    const provider = scriptedProvider({ complete: [reply] });
    await new ChatSpineBuilder(provider, sparkTarget, recordingGuard().guard).buildSpine(intent, researchShape, "medium", {
      ...ctx,
      revision: { previous, violations, attempt: 1, kind: "seed-floor" }
    });
    const sent = provider.requests[0]!.messages;
    expect(sent).toHaveLength(4);
    expect(sent[3]).toEqual({ role: "user", content: buildSeedFloorInstruction(violations) });
    expect(sent[3]!.content).not.toBe(buildSpineFixInstruction(violations));
  });

  it("a 'length' finish throws TruncatedReplyError before anything parses it, after one call", async () => {
    /* MUTATION THAT KILLS THIS: in askStructured, drop the 'length' check
       (the cut reply then parses or is re-asked). Ran it: red. */
    const reply = replyContent("spine-reply");
    const provider = scriptedProvider({ complete: [{ text: reply.slice(0, 900), finishReason: "length" }] });
    await expect(new ChatSpineBuilder(provider, sparkTarget, recordingGuard().guard).buildSpine(intent, researchShape, "short", ctx)).rejects.toBeInstanceOf(
      TruncatedReplyError
    );
    expect(provider.requests).toHaveLength(1);
  });

  it("over the real OpenAI-compatible client, the synthetic spine body yields the same spine and the wire body carries the spine json_schema, max_tokens 8000 and thinking off", async () => {
    /* MUTATION THAT KILLS THIS: in targetFor, take structuredOutput
       'json_object' for every lane (the wire response_format then names no
       schema). Ran it: red. */
    const fake = fakeFetch({ body: openAIFixture("spine-reply") });
    const provider = new OpenAICompatChatProvider({ baseUrl: "http://litellm.invalid:4000", apiKey: "test-key", fetchImpl: fake.fetch });
    const got = await new ChatSpineBuilder(provider, sparkTarget, recordingGuard().guard).buildSpine(intent, researchShape, "medium", ctx);
    const scripted = await new ChatSpineBuilder(scriptedProvider({ complete: [replyContent("spine-reply")] }), sparkTarget, recordingGuard().guard).buildSpine(
      intent,
      researchShape,
      "medium",
      ctx
    );
    expect(got).toEqual(scripted);
    expect(fake.calls).toHaveLength(1);
    const body = fake.calls[0]!.body as { response_format: { type: string; json_schema: { name: string } }; max_tokens: number; chat_template_kwargs: unknown; model: string };
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("spine");
    expect(body.max_tokens).toBe(8000);
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.model).toBe("local-heavy");
  });
});

describe("ChatDeepenActBuilder: act deepening on a ChatProvider", () => {
  it("returns what the Anthropic twin returns for run 2's act 2 reply, asking with the 'deepen_act' schema, cap 4000 and thinking off", async () => {
    /* MUTATION THAT KILLS THIS: send BUILDER_MAX_TOKENS.spine in
       ChatDeepenActBuilder (or schemaName 'spine'). Ran both: red. */
    const reply = replyContent("deepen-reply");
    const provider = scriptedProvider({ complete: [reply] });
    const { checks, guard } = recordingGuard();
    const chat = new ChatDeepenActBuilder(provider, secondTarget, guard);
    const { client } = sequentialAnthropic(reply);
    const anthropic = new AnthropicDeepenActBuilder(anthropicGuard, client);

    const got = await chat.deepenAct(fullSpine, fullSpine.acts[1]!, 1, ctx);
    expect(got).toEqual(await anthropic.deepenAct(fullSpine, fullSpine.acts[1]!, 1, ctx));
    expect(got).toEqual(run2.acts[1]);
    expect(chat.providerName).toBe("local:second");
    const req = provider.requests[0]!;
    expect(req.responseFormat).toBe(responseFormatFor("deepen_act"));
    expect(req).toMatchObject({ maxTokens: BUILDER_MAX_TOKENS.deepen, thinking: false, label: "deepen-act", model: "local-worker" });
    expect(req.messages).toEqual(toChatMessages(buildDeepenActPromptParts(fullSpine, fullSpine.acts[1]!, 1)));
    expect(checks).toEqual([expect.objectContaining({ operation: "deepen_act", provider: "local:second", model: "local-worker" })]);
  });

  it("one invalid reply costs exactly one re-ask, with the same schema and cap; a second invalid reply fails after two calls", async () => {
    /* MUTATION THAT KILLS THIS: in askStructured's reask, drop the
       budget check (the re-ask then goes unmetered). Ran it: red. */
    const reply = replyContent("deepen-reply");
    const provider = scriptedProvider({ complete: ["The act, deepened: (no JSON here)", reply] });
    const { checks, guard } = recordingGuard();
    const got = await new ChatDeepenActBuilder(provider, secondTarget, guard).deepenAct(fullSpine, fullSpine.acts[1]!, 1, ctx);
    expect(got).toEqual(run2.acts[1]);
    expect(provider.requests).toHaveLength(2);
    expect(checks).toHaveLength(2);
    const reask = provider.requests[1]!;
    expect(reask.responseFormat).toBe(responseFormatFor("deepen_act"));
    expect(reask.maxTokens).toBe(BUILDER_MAX_TOKENS.deepen);
    expect(reask.messages.at(-1)).toEqual({ role: "user", content: REASK_LINE });

    const twice: ScriptedReply[] = ["not json", "still not json"];
    const failing = scriptedProvider({ complete: twice });
    await expect(new ChatDeepenActBuilder(failing, secondTarget, recordingGuard().guard).deepenAct(fullSpine, fullSpine.acts[1]!, 1, ctx)).rejects.toThrow();
    expect(failing.requests).toHaveLength(2);
  });
});

describe("ChatContinuityBuilder: act-boundary smoothing on a ChatProvider", () => {
  it("returns what the Anthropic twin returns for the same reply, asking with the 'continuity_smooth' schema, cap 500 and thinking off", async () => {
    /* MUTATION THAT KILLS THIS: send BUILDER_MAX_TOKENS.deepen in
       ChatContinuityBuilder (or schemaName 'deepen_act'). Ran both: red. */
    const request: ContinuitySmoothRequest = {
      previousActTitle: run2.acts[0]!.title,
      previousActExit: run2.acts[0]!.exit,
      nextActTitle: run2.acts[1]!.title,
      nextActIntroduction: run2.acts[1]!.introduction
    };
    const reply = JSON.stringify({ nextIntroduction: "So the data is in order. Now someone has to ship the thing." });
    const provider = scriptedProvider({ complete: [reply] });
    const { checks, guard } = recordingGuard();
    const chat = new ChatContinuityBuilder(provider, sparkTarget, guard);
    const { client } = sequentialAnthropic(reply);
    const anthropic = new AnthropicContinuityBuilder(anthropicGuard, client);

    const got = await chat.smoothSeam(request, ctx);
    expect(got).toEqual(await anthropic.smoothSeam(request, ctx));
    expect(got).toEqual({ nextIntroduction: "So the data is in order. Now someone has to ship the thing." });
    const req = provider.requests[0]!;
    expect(req.responseFormat).toBe(responseFormatFor("continuity_smooth"));
    expect(req).toMatchObject({ maxTokens: BUILDER_MAX_TOKENS.continuity, thinking: false, label: "continuity-smooth" });
    expect(req.messages).toEqual(toChatMessages(buildSmoothPromptParts(request)));
    expect(checks).toEqual([expect.objectContaining({ operation: "continuity_smooth", provider: "local:spark" })]);
  });
});

describe("the Chat builders' structured targets", () => {
  it("every Chat builder reports its target's providerName (local:<lane>)", async () => {
    /* MUTATION THAT KILLS THIS: hard-code providerName 'local' in
       ChatContinuityBuilder. Ran it: red. */
    const target: StructuredTarget = { ...secondTarget };
    const builders = [
      new ChatPromptUnderstander(scriptedProvider({ complete: [] }), target),
      new ChatSpineBuilder(scriptedProvider({ complete: [] }), target),
      new ChatDeepenActBuilder(scriptedProvider({ complete: [] }), target),
      new ChatContinuityBuilder(scriptedProvider({ complete: [] }), target)
    ];
    expect(builders.map((b) => b.providerName)).toEqual(["local:second", "local:second", "local:second", "local:second"]);
  });
});
