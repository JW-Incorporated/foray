import { describe, it, expect, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { ChatNarrationWriterBuilder } from "../src/generation/chat/ChatNarrationWriterBuilder";
import { ChatNarrationVerifierBuilder } from "../src/generation/chat/ChatNarrationVerifierBuilder";
import { targetFor } from "../src/generation/chat/targetFor";
import { responseFormatFor, zodToJsonSchema } from "../src/generation/chat/jsonSchema";
import { OpenAICompatChatProvider } from "../src/generation/chat/openAICompatProvider";
import type { ChatRequest } from "../src/generation/chat/ChatProvider";
import { AnthropicNarrationWriterBuilder, actOutputTokenBudget } from "../src/generation/AnthropicNarrationWriterBuilder";
import { AnthropicNarrationVerifierBuilder } from "../src/generation/AnthropicNarrationVerifierBuilder";
import { toChatMessages } from "../src/generation/promptLayout";
import { actWritePromptParts } from "../src/generation/prompts/actWrite";
import { actVerifyPromptParts } from "../src/generation/prompts/actVerify";
import { RawActVerifySchema, RawActWriteSchema, REPLY_SCHEMAS, toActVerifyResult, toActWriteResult } from "../src/generation/replySchemas";
import { TruncatedReplyError } from "../src/generation/replyErrors";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { runForayPipeline, type RunPipelineDeps } from "../src/generation/runPipeline";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { ActWriteRequest, NarrationBuildContext, NarrationWriterBuilder } from "../src/generation/NarrationWriterBuilder";
import type { ActVerifyRequest, NarrationVerifierBuilder } from "../src/generation/NarrationVerifierBuilder";
import type { EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import { DEFAULT_LANE_PROFILES } from "../src/config/machineProfiles";
import { BUILDER_MAX_TOKENS } from "../src/config/outputBudgets";
import type { StageRoute } from "../src/config/stageRouting";
import type { CostEventInput } from "../src/cost/costEvents";
import type { GenerationRequest } from "../src/types/generation";
import type { Voice } from "../src/types/spine";
import { scriptedProvider } from "./helpers/fakeChatProvider";
import { fakeFetch, openAIFixture } from "./helpers/fakeFetch";
import { textBlock } from "./helpers/fakeAnthropicClient";

/**
 * GV-31 (docs/roadmap/generation-v2.md, from W2-07; covers R2-21, GP-06,
 * HW-12, R1-18): the Chat twins of the act writer and the act verifier.
 * Offline only: scriptedProvider replies, one fakeFetch replay of a synthetic
 * OpenAI body, the Anthropic twins on an injected fake client, and one
 * short-tier runForayPipeline whose provider answers with the Stub builders'
 * JSON. No network, no model, no key. Each test names the mutation that
 * turns it red; every one was run.
 */

const GENERATION_DIR = path.join(__dirname, "..", "src", "generation");

/** The content string of a committed synthetic OpenAI chat.completion. */
function replyContent(name: string): string {
  const body = openAIFixture(name) as { choices: Array<{ message: { content: string } }> };
  return body.choices[0]!.message.content;
}

const ctx: NarrationBuildContext = { userId: "founder-1", sessionId: "s1" };

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

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };

const NBS: EvidenceDoc = {
  docId: "print:nbs-143",
  kind: "print",
  title: "National Bureau of Standards, Building Science Series 143 (1982)",
  url: "https://nvlpubs.nist.gov/nistpubs/Legacy/BSS/nbsbuildingscience143.pdf",
  retrievedAt: "2026-09-09T00:00:00.000Z",
  text:
    "The box beam-hanger rod connections were not checked for adequacy at any stage of the design. " +
    "The as-built connection could support about sixty percent of the load required by the Kansas City Building Code."
};

/** The act the act-write-reply fixture answers: two narration seams, no clips. */
const writeRequest: ActWriteRequest = {
  actTitle: "The connection nobody checked",
  voice,
  seams: [
    { seamId: "s0", beats: [{ beatId: "b0", claim: "The hanger-rod connection was never checked during design.", mode: "Patch", kind: "account" }], band: [200, 600] },
    { seamId: "s1", beats: [{ beatId: "b1", claim: "As built, it held about sixty percent of the code load.", mode: "Patch", kind: "account" }], band: [200, 600] }
  ],
  clips: [],
  documents: [NBS]
};

/** The same act, written, as the verifier sees it (the act-verify-reply fixture). */
const verifyRequest: ActVerifyRequest = {
  actTitle: writeRequest.actTitle,
  voice,
  beats: writeRequest.seams.flatMap((s) => s.beats),
  seams: [
    { seamId: "s0", script: "Nobody checked the hanger-rod connection, at any stage of the design.", selected: ["k0"], carries: ["b0"] },
    { seamId: "s1", script: "As built, it could carry about sixty percent of what the code required.", selected: ["k1"], carries: ["b1"] }
  ],
  clips: [],
  sources: [
    {
      id: "k0",
      kind: "claim",
      claimText: "The connection was never checked.",
      quote: "The box beam-hanger rod connections were not checked for adequacy at any stage of the design.",
      publication: NBS.title,
      contested: false,
      selectedBy: "s0",
      docId: NBS.docId
    },
    {
      id: "k1",
      kind: "claim",
      claimText: "It held about sixty percent of the code load.",
      quote: "The as-built connection could support about sixty percent of the load required by the Kansas City Building Code.",
      publication: NBS.title,
      contested: false,
      selectedBy: "s1",
      docId: NBS.docId
    }
  ],
  documents: [NBS]
};

describe("ChatNarrationWriterBuilder: the act writer on a ChatProvider", () => {
  it("a recorded-shape reply yields the ActWriteResult the Anthropic twin produces, pronunciationHints defaulted to [], asked with the act prompt, the 'act_write' schema, actOutputTokenBudget and thinking off", async () => {
    /* MUTATION THAT KILLS THIS: in ChatNarrationWriterBuilder.writeAct,
       `return value` instead of `return toActWriteResult(value)` (seam s1
       then has no pronunciationHints). Ran it: red. */
    const reply = replyContent("act-write-reply");
    const provider = scriptedProvider({ complete: [reply] });
    const { checks, guard } = recordingGuard();
    const chat = new ChatNarrationWriterBuilder(provider, sparkTarget, guard);
    const { client } = sequentialAnthropic(reply);
    const anthropic = new AnthropicNarrationWriterBuilder(anthropicGuard, client);

    const got = await chat.writeAct(writeRequest, ctx);
    expect(got).toEqual(await anthropic.writeAct(writeRequest, ctx));
    expect(got.seams.map((s) => s.seamId)).toEqual(["s0", "s1"]);
    expect(got.seams[0]!.pronunciationHints).toEqual([{ word: "Hyatt", hint: "HIGH-it" }]);
    expect(got.seams[1]!.pronunciationHints).toEqual([]);
    expect(chat.providerName).toBe("local:spark");

    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.responseFormat).toBe(responseFormatFor("act_write"));
    expect(req).toMatchObject({ model: "local-heavy", maxTokens: actOutputTokenBudget(writeRequest), thinking: false, label: "narration_write_act" });
    /* GV-50: [system: stable, user: foray + call], the same parts the
       Anthropic writer sends joined as one user turn. */
    expect(req.messages).toEqual(toChatMessages(actWritePromptParts(writeRequest)));
    expect(checks).toEqual([
      expect.objectContaining({ operation: "narration_write_act", provider: "local:spark", model: "local-heavy", userId: "founder-1", sessionId: "s1" })
    ]);
  });

  it("maxTokens is actOutputTokenBudget(request), sized from the seam bands above the 12000 floor, and response_format names RawActWriteSchema", async () => {
    /* MUTATION THAT KILLS THIS: send `maxTokens: 12000` (the floor) in
       ChatNarrationWriterBuilder instead of actOutputTokenBudget(request).
       Ran it: red. */
    const wide: ActWriteRequest = {
      ...writeRequest,
      seams: Array.from({ length: 30 }, (_, i) => ({ seamId: `s${i}`, beats: [], band: [400, 1000] as [number, number] }))
    };
    const budget = actOutputTokenBudget(wide);
    expect(budget).toBe(15000);
    const reply = JSON.stringify({ seams: wide.seams.map((s) => ({ seamId: s.seamId, script: "", claims: [], usedClaims: [] })) });
    const provider = scriptedProvider({ complete: [reply] });
    await new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard).writeAct(wide, ctx);
    const req = provider.requests[0]!;
    expect(req.maxTokens).toBe(budget);
    expect(REPLY_SCHEMAS.act_write).toBe(RawActWriteSchema);
    const format = req.responseFormat as { type: string; name: string; schema: unknown };
    expect(format.type).toBe("json_schema");
    expect(format.name).toBe("act_write");
    expect(format.schema).toEqual(zodToJsonSchema(RawActWriteSchema));
  });

  it("a 'length' finish throws TruncatedReplyError before anything parses it, after one call", async () => {
    /* MUTATION THAT KILLS THIS: in askStructured, drop the 'length' check
       (the cut act would parse as a shorter one, the 2026-09-13 defect 1
       the Anthropic writer refuses). Ran it: red. */
    const reply = replyContent("act-write-reply");
    const provider = scriptedProvider({ complete: [{ text: reply.slice(0, reply.indexOf('{"seamId":"s1"')) + "]}", finishReason: "length" }] });
    await expect(new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard).writeAct(writeRequest, ctx)).rejects.toBeInstanceOf(TruncatedReplyError);
    expect(provider.requests).toHaveLength(1);
  });

  it("over the real OpenAI-compatible client, the synthetic writer body yields the same result and the wire body carries the act_write json_schema, the act's max_tokens and thinking off", async () => {
    /* MUTATION THAT KILLS THIS: schemaName 'act_verify' in
       ChatNarrationWriterBuilder (the wire then names the verifier's
       schema). Ran it: red. */
    const fake = fakeFetch({ body: openAIFixture("act-write-reply") });
    const provider = new OpenAICompatChatProvider({ baseUrl: "http://litellm.invalid:4000", apiKey: "test-key", fetchImpl: fake.fetch });
    const got = await new ChatNarrationWriterBuilder(provider, sparkTarget, recordingGuard().guard).writeAct(writeRequest, ctx);
    expect(got).toEqual(toActWriteResult(RawActWriteSchema.parse(JSON.parse(replyContent("act-write-reply")))));
    expect(fake.calls).toHaveLength(1);
    const body = fake.calls[0]!.body as { response_format: { type: string; json_schema: { name: string } }; max_tokens: number; chat_template_kwargs: unknown; model: string };
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.name).toBe("act_write");
    expect(body.max_tokens).toBe(actOutputTokenBudget(writeRequest));
    expect(body.chat_template_kwargs).toEqual({ enable_thinking: false });
    expect(body.model).toBe("local-heavy");
  });
});

describe("ChatNarrationVerifierBuilder: the act verifier on a ChatProvider", () => {
  it("a recorded-shape reply yields the ActVerifyResult the Anthropic twin produces, restsOn defaulted to [], asked with the verify prompt, the 'act_verify' schema, the verifier cap and thinking off", async () => {
    /* MUTATION THAT KILLS THIS: in ChatNarrationVerifierBuilder.verifyAct,
       `return value` instead of `return toActVerifyResult(value)` (seam s1
       then has no restsOn). Ran it: red. */
    const reply = replyContent("act-verify-reply");
    const provider = scriptedProvider({ complete: [reply] });
    const { checks, guard } = recordingGuard();
    const chat = new ChatNarrationVerifierBuilder(provider, secondTarget, guard);
    const { client } = sequentialAnthropic(reply);
    const anthropic = new AnthropicNarrationVerifierBuilder(anthropicGuard, client);

    const got = await chat.verifyAct(verifyRequest, ctx);
    expect(got).toEqual(await anthropic.verifyAct(verifyRequest, ctx));
    expect(got.beats.map((b) => [b.beatId, b.carried, b.carriedBy])).toEqual([
      ["b0", true, "s0"],
      ["b1", true, "s1"]
    ]);
    expect(got.seams[0]!.restsOn).toEqual(["k0"]);
    expect(got.seams[1]!.restsOn).toEqual([]);
    expect(chat.providerName).toBe("local:second");

    expect(provider.requests).toHaveLength(1);
    const req = provider.requests[0]!;
    expect(req.responseFormat).toBe(responseFormatFor("act_verify"));
    expect(req).toMatchObject({ model: "local-worker", maxTokens: BUILDER_MAX_TOKENS.verifier, thinking: false, label: "narration-verify" });
    expect(req.messages).toEqual(toChatMessages(actVerifyPromptParts(verifyRequest)));
    expect(checks).toEqual([expect.objectContaining({ operation: "narration_verify", provider: "local:second", model: "local-worker" })]);
  });

  it("one invalid reply costs exactly one metered re-ask with the same schema and cap", async () => {
    /* MUTATION THAT KILLS THIS: in ChatNarrationVerifierBuilder, send
       BUILDER_MAX_TOKENS.spine as maxTokens (both asks then carry the wrong
       cap; .deepen is the same 4000 and would survive). Ran it: red. */
    const provider = scriptedProvider({ complete: ["Verdicts: every beat is carried.", replyContent("act-verify-reply")] });
    const { checks, guard } = recordingGuard();
    const got = await new ChatNarrationVerifierBuilder(provider, secondTarget, guard).verifyAct(verifyRequest, ctx);
    expect(got.seams).toHaveLength(2);
    expect(provider.requests).toHaveLength(2);
    expect(checks).toHaveLength(2);
    for (const req of provider.requests) {
      expect(req.responseFormat).toBe(responseFormatFor("act_verify"));
      expect(req.maxTokens).toBe(BUILDER_MAX_TOKENS.verifier);
    }
  });
});

describe("the post-parse mappings are shared", () => {
  it("toActWriteResult and toActVerifyResult default the optional lists and keep everything else", () => {
    /* MUTATION THAT KILLS THIS: in toActVerifyResult, replace
       `s.restsOn ?? []` with `[]` (a named restsOn is then lost). Ran it: red. */
    const write = toActWriteResult(RawActWriteSchema.parse(JSON.parse(replyContent("act-write-reply"))));
    expect(write.seams.map((s) => s.pronunciationHints.length)).toEqual([1, 0]);
    expect(write.seams[0]!.claims[0]!.docId).toBe("print:nbs-143");
    const verify = toActVerifyResult(RawActVerifySchema.parse(JSON.parse(replyContent("act-verify-reply"))));
    expect(verify.seams.map((s) => s.restsOn)).toEqual([["k0"], []]);
    expect(verify.beats[1]!.notes).toBe("carried by the sixty-percent sentence");
  });

  it("both Anthropic classes and both Chat classes map through replySchemas.ts and none keeps its own copy", () => {
    /* MUTATION THAT KILLS THIS: put the inline
       `raw.seams.map((s) => ({ ...s, pronunciationHints: s.pronunciationHints ?? [] }))`
       back into AnthropicNarrationWriterBuilder.writeAct. Ran it: red. */
    const read = (rel: string) => fs.readFileSync(path.join(GENERATION_DIR, rel), "utf8");
    const files: Array<[string, string]> = [
      ["AnthropicNarrationWriterBuilder.ts", "toActWriteResult"],
      ["chat/ChatNarrationWriterBuilder.ts", "toActWriteResult"],
      ["AnthropicNarrationVerifierBuilder.ts", "toActVerifyResult"],
      ["chat/ChatNarrationVerifierBuilder.ts", "toActVerifyResult"]
    ];
    for (const [file, fn] of files) {
      const src = read(file);
      expect(src, file).toMatch(new RegExp(`return ${fn}\\(`));
      expect(src, file).not.toMatch(/pronunciationHints \?\? \[\]|restsOn \?\? \[\]/);
    }
  });

  it("the Chat writer and verifier report their target's providerName and are distinct classes", () => {
    /* MUTATION THAT KILLS THIS: hard-code providerName 'local' in
       ChatNarrationVerifierBuilder. Ran it: red. */
    const writer = new ChatNarrationWriterBuilder(scriptedProvider({ complete: [] }), secondTarget);
    const verifier = new ChatNarrationVerifierBuilder(scriptedProvider({ complete: [] }), sparkTarget);
    expect([writer.providerName, verifier.providerName]).toEqual(["local:second", "local:spark"]);
    expect(writer).not.toBeInstanceOf(ChatNarrationVerifierBuilder);
    expect(verifier).not.toBeInstanceOf(ChatNarrationWriterBuilder);
  });
});

/* ------------------------------------------------------------------------ */

describe("runForayPipeline with both Chat narration builders injected (short tier, offline)", () => {
  const request: GenerationRequest = {
    prompt: "the history of grilling and barbecue",
    duration: "short",
    author_id: "founder-1",
    visibility: "catalogue"
  };
  const options = { userId: "founder-1", now: () => new Date("2026-09-05T12:00:00.000Z"), topic: "food/grilling-bbq" };

  const gatherer: EvidenceGatherer = {
    async gather(beat): Promise<EvidencePack> {
      return { purpose: beat.claim, beatKind: "account", docs: [NBS] };
    }
  };

  function fakeFinalize() {
    return async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
      ({
        validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
        forayRecord: { id: input.id, generated: true } as never,
        timings: []
      }) as unknown as FinalizeForayResult;
  }

  function planningDeps(): RunPipelineDeps {
    return {
      understander: new StubPromptUnderstander(),
      researcher: new StubExternalResearcher(),
      spineBuilder: new StubSpineBuilder(),
      deepenBuilder: new StubDeepenActBuilder(),
      continuityBuilder: new StubContinuityBuilder(),
      evidence: gatherer,
      finalize: fakeFinalize()
    };
  }

  /**
   * The responder. A test wrapper captures each request BEFORE delegating to
   * the Chat builder, asks the Stub builder for its answer to that same
   * request, and files the Stub's JSON under the prompt the Chat builder is
   * about to send. The scripted provider answers each call by that prompt, so
   * every seam id, beat id and quote in the reply belongs to the request.
   */
  function stubAnsweredChatBuilders() {
    const answers = new Map<string, string>();
    const stubWriter = new StubNarrationWriterBuilder(recordingGuard().guard as never);
    const stubVerifier = new StubNarrationVerifierBuilder(recordingGuard().guard as never);
    const provider = scriptedProvider({
      complete: (req: ChatRequest) => {
        /* GV-50: the system message is the same for every call (the
           cached prefix), so an answer is filed under the whole opening. */
        const answer = answers.get(JSON.stringify(req.messages.slice(0, 2)));
        if (answer === undefined) throw new Error(`no stub answer filed for this ${req.label} prompt`);
        return answer;
      }
    });
    const { guard } = recordingGuard();
    const chatWriter = new ChatNarrationWriterBuilder(provider, sparkTarget, guard);
    const chatVerifier = new ChatNarrationVerifierBuilder(provider, secondTarget, guard);
    const writes: ActWriteRequest[] = [];
    const verifies: ActVerifyRequest[] = [];
    const writer: NarrationWriterBuilder = {
      providerName: chatWriter.providerName,
      async writeAct(req, c) {
        writes.push(req);
        answers.set(JSON.stringify(toChatMessages(actWritePromptParts(req))), JSON.stringify(await stubWriter.writeAct(req, c)));
        return chatWriter.writeAct(req, c);
      }
    };
    const verifier: NarrationVerifierBuilder = {
      providerName: chatVerifier.providerName,
      async verifyAct(req, c) {
        verifies.push(req);
        answers.set(JSON.stringify(toChatMessages(actVerifyPromptParts(req))), JSON.stringify(await stubVerifier.verifyAct(req, c)));
        return chatVerifier.verifyAct(req, c);
      }
    };
    return { writer, verifier, provider, writes, verifies };
  }

  it("completes a short-tier run, every writer and verifier call goes through the provider with its schema, and the Foray equals the all-Stub run's", async () => {
    /* MUTATION THAT KILLS THIS: in toActVerifyResult, map
       `claimsSupported: false` onto every seam verdict (the Stub's verdicts
       then reach writeAct.ts changed, a page is refused and the Foray has one
       item fewer than the all-Stub run's). Ran it: red. */
    const chat = stubAnsweredChatBuilders();
    const out = await runForayPipeline(request, options, { ...planningDeps(), narrationWriter: chat.writer, narrationVerifier: chat.verifier });
    const baseline = await runForayPipeline(request, options, {
      ...planningDeps(),
      narrationWriter: new StubNarrationWriterBuilder(recordingGuard().guard as never),
      narrationVerifier: new StubNarrationVerifierBuilder(recordingGuard().guard as never)
    });

    expect(out.outcome).toBe("generated");
    expect(baseline.outcome).toBe("generated");
    if (out.outcome !== "generated" || baseline.outcome !== "generated") return;
    expect(out.spine.duration).toBe("short");

    expect(chat.writes.length).toBeGreaterThan(0);
    expect(chat.verifies.length).toBeGreaterThan(0);
    const writeCalls = chat.provider.requests.filter((r) => r.label === "narration_write_act");
    const verifyCalls = chat.provider.requests.filter((r) => r.label === "narration-verify");
    expect(writeCalls).toHaveLength(chat.writes.length);
    expect(verifyCalls).toHaveLength(chat.verifies.length);
    expect(writeCalls.length + verifyCalls.length).toBe(chat.provider.requests.length);
    for (const r of writeCalls) expect(r.responseFormat).toBe(responseFormatFor("act_write"));
    for (const r of verifyCalls) expect(r.responseFormat).toBe(responseFormatFor("act_verify"));

    expect(out.input.items).toEqual(baseline.input.items);
    expect(out.input.slots).toEqual(baseline.input.slots);
    expect(out.input.items.length).toBeGreaterThan(0);
  });
});
