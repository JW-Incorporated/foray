import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import type Anthropic from "@anthropic-ai/sdk";
import { createMessage } from "../src/generation/anthropicCall";
import { anthropicCallCount, resetUsageTracking } from "../src/generation/usageTracking";
import { resolveRouting } from "../src/config/stageRouting";
import { runForayPipeline } from "../src/generation/runPipeline";
import { __setChatProviderForTests } from "../src/generation/chat/providerRegistry";
import { createNarrationWriterBuilder } from "../src/generation/createNarrationWriterBuilder";
import { createNarrationVerifierBuilder } from "../src/generation/createNarrationVerifierBuilder";
import { createContinuityBuilder } from "../src/generation/createContinuityBuilder";
import { ChatNarrationWriterBuilder } from "../src/generation/chat/ChatNarrationWriterBuilder";
import { ChatNarrationVerifierBuilder } from "../src/generation/chat/ChatNarrationVerifierBuilder";
import { ChatContinuityBuilder } from "../src/generation/chat/ChatContinuityBuilder";
import { toChatMessages } from "../src/generation/promptLayout";
import { actWritePromptParts } from "../src/generation/prompts/actWrite";
import { actVerifyPromptParts } from "../src/generation/prompts/actVerify";
import { buildSmoothPromptParts } from "../src/generation/prompts/continuity";
import { NullExternalResearcher } from "../src/generation/NullExternalResearcher";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { ChatRequest } from "../src/generation/chat/ChatProvider";
import type { NarrationWriterBuilder } from "../src/generation/NarrationWriterBuilder";
import type { NarrationVerifierBuilder } from "../src/generation/NarrationVerifierBuilder";
import type { ContinuityBuilder } from "../src/generation/ContinuityBuilder";
import type { EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { GenerationRequest } from "../src/types/generation";
import { scriptedProvider } from "./helpers/fakeChatProvider";

/**
 * GV-68 (docs/roadmap/generation-v2.md, from W2-15; covers HW-12, GP-06): the
 * founder's rule "the generation pipeline makes ZERO Anthropic calls", proved
 * by CI instead of by convention.
 *
 * 1. STRUCTURAL. Every .ts file under backend/src/generation/** plus
 *    cli/generateForays.ts and cli/generateForay.ts is scanned for module
 *    specifiers (import/export from, side-effect import, require(), import()).
 *    Only the LEGACY_ANTHROPIC allowlist (the seven Anthropic*.ts builders and
 *    anthropicCall.ts) may name '@anthropic-ai/sdk', './anthropicCall' or an
 *    './Anthropic*' module; the create*.ts factories may do so only on their
 *    lazy `require("./AnthropicX") as typeof import("./AnthropicX")` line.
 *    chat/**, jevClient.ts and qwenJudgeClient.ts are covered by the same rule
 *    (there is no jev/ folder). enrich/AnthropicEnricher.ts is out of scope by
 *    design. And only anthropicCall.ts may call `.messages.create(` or
 *    `.messages.stream(`, so createMessage's counter sees every request.
 * 2. THE COUNTER. createMessage counts every Anthropic request, failed ones
 *    too, in a per-process count (usageTracking.anthropicCallCount) that the
 *    batch driver writes into report.json as anthropicCalls.
 * 3. A LOCAL RUN. A local-mode runForayPipeline whose writer, verifier and
 *    continuity are the real local factories' Chat* builders (answered by a
 *    scripted provider with the Stub builders' JSON) sends 0 Anthropic
 *    requests.
 *
 * Offline only: no network, no key, no model. Each test names the mutation
 * that turns it red; every one was run.
 */

const SRC = path.resolve(__dirname, "..", "src");
const GENERATION = path.join(SRC, "generation");

/** The legacy Anthropic builders: the only files besides anthropicCall.ts that
 * may import the SDK or anthropicCall. A new Anthropic*.ts is refused. */
const LEGACY_ANTHROPIC = new Set([
  "generation/AnthropicContinuityBuilder.ts",
  "generation/AnthropicDeepenActBuilder.ts",
  "generation/AnthropicExternalResearcher.ts",
  "generation/AnthropicNarrationVerifierBuilder.ts",
  "generation/AnthropicNarrationWriterBuilder.ts",
  "generation/AnthropicPromptUnderstander.ts",
  "generation/AnthropicSpineBuilder.ts",
  "generation/anthropicCall.ts"
]);

/**
 * KNOWN DEBT, pinned to the exact statement: the Chat writer borrows the pure
 * per-act budget function from the legacy writer (decision 10: "the writer
 * keeps actOutputTokenBudget"). It names no SDK symbol and makes no call; it
 * goes when the Anthropic builders are retired (GV-96). Any OTHER binding
 * from that module, or any other import, fails this suite.
 */
const KNOWN_DEBT: ReadonlyMap<string, string> = new Map([
  ["generation/chat/ChatNarrationWriterBuilder.ts", 'import { actOutputTokenBudget } from "../AnthropicNarrationWriterBuilder";']
]);

/** create*.ts's lazy require of its legacy builder. */
const LAZY_REQUIRE = /^\s*const \{ (Anthropic\w+) \} = require\("\.\/(Anthropic\w+)"\) as typeof import\("\.\/(Anthropic\w+)"\);\s*$/;

const SPECIFIER = /(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|^\s*import\s+)["']([^"']+)["']/g;

/** True when a module specifier names the Anthropic SDK, anthropicCall or an Anthropic* module. */
function isAnthropicSpecifier(spec: string): boolean {
  if (spec === "@anthropic-ai/sdk" || spec.startsWith("@anthropic-ai/")) return true;
  if (!spec.startsWith(".")) return false;
  const base = spec.split("/").pop()!.replace(/\.(ts|js)$/, "");
  return base === "anthropicCall" || /^Anthropic[A-Z]\w*$/.test(base);
}

interface Violation {
  file: string;
  line: number;
  text: string;
  spec: string;
}

/** The forbidden imports in one file's source (rel is the path under src/, with forward slashes). */
function anthropicImportViolations(rel: string, source: string): Violation[] {
  if (LEGACY_ANTHROPIC.has(rel)) return [];
  const out: Violation[] = [];
  const isFactory = /^generation\/create\w+\.ts$/.test(rel);
  source.split(/\r?\n/).forEach((text, i) => {
    for (const m of text.matchAll(SPECIFIER)) {
      const spec = m[1]!;
      if (!isAnthropicSpecifier(spec)) continue;
      if (isFactory) {
        const lazy = LAZY_REQUIRE.exec(text);
        if (lazy && lazy[1] === lazy[2] && lazy[2] === lazy[3] && LEGACY_ANTHROPIC.has(`generation/${lazy[2]}.ts`)) continue;
      }
      if (KNOWN_DEBT.get(rel) === text.trim()) continue;
      out.push({ file: rel, line: i + 1, text: text.trim(), spec });
    }
  });
  return out;
}

/** Direct SDK calls outside anthropicCall.ts (createMessage must see every
 * request). Comment lines are skipped. */
function directCallViolations(rel: string, source: string): Violation[] {
  if (rel === "generation/anthropicCall.ts") return [];
  const out: Violation[] = [];
  source.split(/\r?\n/).forEach((text, i) => {
    /* A comment line that names the call is not a call. */
    if (/^\s*(\/\/|\/\*|\*)/.test(text)) return;
    if (/\.messages\s*\.\s*(create|stream)\s*\(/.test(text)) out.push({ file: rel, line: i + 1, text: text.trim(), spec: "messages.create" });
  });
  return out;
}

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function scannedFiles(): Array<{ rel: string; source: string }> {
  const files = [...walk(GENERATION), path.join(SRC, "cli", "generateForays.ts"), path.join(SRC, "cli", "generateForay.ts")];
  return files.map((full) => ({ rel: path.relative(SRC, full).split(path.sep).join("/"), source: fs.readFileSync(full, "utf8") }));
}

describe("GV-68: structural guard — only the legacy allowlist may reach Anthropic", () => {
  /* MUTATION THAT KILLS THIS: plant `import Anthropic from "@anthropic-ai/sdk";`
     at the top of chat/ChatSpineBuilder.ts (or `import { createMessage } from
     "../anthropicCall";` in jevClient.ts). Ran both: red, naming the file and
     line. */
  it("no file outside LEGACY_ANTHROPIC imports the SDK, anthropicCall or an Anthropic* module", () => {
    const files = scannedFiles();
    expect(files.some((f) => f.rel.startsWith("generation/chat/"))).toBe(true);
    expect(files.some((f) => f.rel === "generation/jevClient.ts")).toBe(true);
    expect(files.some((f) => f.rel === "generation/qwenJudgeClient.ts")).toBe(true);
    expect(files.some((f) => f.rel === "cli/generateForays.ts")).toBe(true);
    const violations = files.flatMap((f) => anthropicImportViolations(f.rel, f.source));
    expect(violations).toEqual([]);
  });

  /* MUTATION THAT KILLS THIS: add AnthropicJudgeBuilder.ts (any new
     Anthropic*.ts) under generation/, or a bare `client.messages.create(`
     call in an Anthropic* builder (bypassing createMessage and its count).
     Ran both: red. */
  it("no new Anthropic*.ts appears, and only anthropicCall.ts calls messages.create/stream", () => {
    const onDisk = walk(GENERATION)
      .map((full) => path.relative(SRC, full).split(path.sep).join("/"))
      .filter((rel) => /\/Anthropic\w*\.ts$/.test(rel));
    for (const rel of onDisk) expect(LEGACY_ANTHROPIC.has(rel), rel).toBe(true);
    const files = scannedFiles();
    expect(files.flatMap((f) => directCallViolations(f.rel, f.source))).toEqual([]);
    const call = files.find((f) => f.rel === "generation/anthropicCall.ts")!;
    expect(call.source).toMatch(/client\.messages\.create\(params\)/);
  });

  /* MUTATION THAT KILLS THIS: make isAnthropicSpecifier match only
     "@anthropic-ai/sdk" (or drop the LAZY_REQUIRE check so any import in a
     create*.ts passes). Ran both: red. */
  it("the scanner flags a planted import in a chat file and a non-lazy import in a factory, and passes the pinned debt only", () => {
    const planted = anthropicImportViolations("generation/chat/ChatSpineBuilder.ts", 'import Anthropic from "@anthropic-ai/sdk";\nexport const x = 1;\n');
    expect(planted).toHaveLength(1);
    expect(planted[0]).toMatchObject({ line: 1, spec: "@anthropic-ai/sdk" });
    expect(anthropicImportViolations("generation/jevClient.ts", 'import { createMessage } from "./anthropicCall";')).toHaveLength(1);
    expect(anthropicImportViolations("generation/qwenJudgeClient.ts", 'const m = require("./AnthropicSpineBuilder");')).toHaveLength(1);
    expect(anthropicImportViolations("generation/createSpineBuilder.ts", 'import { AnthropicSpineBuilder } from "./AnthropicSpineBuilder";')).toHaveLength(1);
    expect(
      anthropicImportViolations(
        "generation/createSpineBuilder.ts",
        '    const { AnthropicSpineBuilder } = require("./AnthropicSpineBuilder") as typeof import("./AnthropicSpineBuilder");'
      )
    ).toEqual([]);
    /* The debt is the exact statement; a second binding is refused. */
    expect(anthropicImportViolations("generation/chat/ChatNarrationWriterBuilder.ts", KNOWN_DEBT.get("generation/chat/ChatNarrationWriterBuilder.ts")!)).toEqual([]);
    expect(
      anthropicImportViolations(
        "generation/chat/ChatNarrationWriterBuilder.ts",
        'import { actOutputTokenBudget, AnthropicNarrationWriterBuilder } from "../AnthropicNarrationWriterBuilder";'
      )
    ).toHaveLength(1);
    expect(isAnthropicSpecifier("./anthropicCall")).toBe(true);
    expect(isAnthropicSpecifier("../generation/AnthropicSpineBuilder")).toBe(true);
    expect(isAnthropicSpecifier("./replyErrors")).toBe(false);
    expect(isAnthropicSpecifier("./chat/askStructured")).toBe(false);
  });
});

describe("GV-68: createMessage counts every Anthropic request, per process", () => {
  /* MUTATION THAT KILLS THIS: delete countAnthropicCall() from createMessage
     (or move it after the await, so a failed request is not counted). Ran
     both: red. */
  it("a sent request and a failed request each count once, and resetUsageTracking does not reset the count", async () => {
    const before = anthropicCallCount();
    const ok = {
      messages: { create: async () => ({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) }
    } as unknown as Anthropic;
    const failing = {
      messages: {
        create: async () => {
          throw new Error("connection error");
        }
      }
    } as unknown as Anthropic;
    const params = { model: "m", max_tokens: 10, messages: [{ role: "user", content: "x" }] } as Anthropic.MessageCreateParamsNonStreaming;
    await createMessage(ok, params, "probe");
    await expect(createMessage(failing, params, "probe")).rejects.toThrow("connection error");
    expect(anthropicCallCount() - before).toBe(2);
    resetUsageTracking();
    expect(anthropicCallCount() - before).toBe(2);
  });
});

describe("GV-68: a local-mode run sends zero Anthropic requests", () => {
  const LLM = "http://litellm.invalid:4000";
  const request: GenerationRequest = { prompt: "the history of grilling and barbecue", duration: "short", author_id: "founder-1", visibility: "catalogue" };
  const options = { userId: "founder-1", now: () => new Date("2026-09-05T12:00:00.000Z"), topic: "food/grilling-bbq" };
  const DOC: EvidenceDoc = {
    docId: "print:fixture-1",
    kind: "print",
    title: "A synthetic print source",
    url: "https://example.invalid/print-1",
    retrievedAt: "2026-09-09T00:00:00.000Z",
    text: "Barbecue grew out of slow cooking over smoke, long before backyard grills."
  };
  const gatherer: EvidenceGatherer = {
    async gather(beat): Promise<EvidencePack> {
      return { purpose: beat.claim, beatKind: "account", docs: [DOC] };
    }
  };
  const finalize = async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
    ({
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: input.id, generated: true } as never,
      timings: []
    }) as unknown as FinalizeForayResult;

  afterEach(() => __setChatProviderForTests(undefined));

  /**
   * The local factories build the Chat builders on the scripted provider
   * (__setChatProviderForTests). A wrapper asks the Stub builder for its
   * answer to each request and files the Stub's JSON under the prompt the
   * Chat builder is about to send (chatNarrationBuilders.test.ts's pattern),
   * so every id in a reply belongs to its request.
   */
  function localChatBuilders() {
    const answers = new Map<string, string>();
    const provider = scriptedProvider({
      complete: (req: ChatRequest) => {
        const answer = answers.get(JSON.stringify(req.messages.slice(0, 2)));
        if (answer === undefined) throw new Error(`no stub answer filed for this ${req.label} prompt`);
        return answer;
      }
    });
    __setChatProviderForTests(provider);
    const source = { FORAY_LLM_BASE_URL: LLM };
    const chatWriter = createNarrationWriterBuilder(source);
    const chatVerifier = createNarrationVerifierBuilder(source);
    const chatContinuity = createContinuityBuilder(source);
    expect(chatWriter).toBeInstanceOf(ChatNarrationWriterBuilder);
    expect(chatVerifier).toBeInstanceOf(ChatNarrationVerifierBuilder);
    expect(chatContinuity).toBeInstanceOf(ChatContinuityBuilder);
    const key = (parts: Parameters<typeof toChatMessages>[0]) => JSON.stringify(toChatMessages(parts).slice(0, 2));
    const stubWriter = new StubNarrationWriterBuilder();
    const stubVerifier = new StubNarrationVerifierBuilder();
    const stubContinuity = new StubContinuityBuilder();
    const writer: NarrationWriterBuilder = {
      providerName: chatWriter.providerName,
      async writeAct(req, c) {
        answers.set(key(actWritePromptParts(req)), JSON.stringify(await stubWriter.writeAct(req, c)));
        return chatWriter.writeAct(req, c);
      }
    };
    const verifier: NarrationVerifierBuilder = {
      providerName: chatVerifier.providerName,
      async verifyAct(req, c) {
        answers.set(key(actVerifyPromptParts(req)), JSON.stringify(await stubVerifier.verifyAct(req, c)));
        return chatVerifier.verifyAct(req, c);
      }
    };
    const continuity: ContinuityBuilder = {
      providerName: chatContinuity.providerName,
      async smoothSeam(req, c) {
        answers.set(key(buildSmoothPromptParts(req)), JSON.stringify(await stubContinuity.smoothSeam(req, c)));
        return chatContinuity.smoothSeam(req, c);
      }
    };
    return { provider, writer, verifier, continuity };
  }

  /* MUTATION THAT KILLS THIS: let the Chat writer reach the Anthropic path
     (a `countAnthropicCall()` at the top of ChatNarrationWriterBuilder.writeAct,
     standing in for a createMessage fallback). Ran it: red (anthropicCalls is
     the act count). The counter itself is pinned by the createMessage case
     above. */
  it("routing local, Chat writer/verifier/continuity on the scripted lane: the run is generated and anthropicCalls is 0", async () => {
    const routing = resolveRouting({ FORAY_LLM_BASE_URL: LLM });
    expect(routing.mode).toBe("local");
    expect(routing.routes.writer).toMatchObject({ provider: "local", lane: "spark" });
    expect(Object.values(routing.routes).some((r) => r?.provider === "anthropic")).toBe(false);

    const chat = localChatBuilders();
    const before = anthropicCallCount();
    const out = await runForayPipeline(
      request,
      { ...options, routing },
      {
        understander: new StubPromptUnderstander(),
        researcher: new NullExternalResearcher(),
        spineBuilder: new StubSpineBuilder(),
        deepenBuilder: new StubDeepenActBuilder(),
        narrationWriter: chat.writer,
        narrationVerifier: chat.verifier,
        continuityBuilder: chat.continuity,
        evidence: gatherer,
        finalize
      }
    );
    expect(out.outcome).toBe("generated");
    const labels = new Set(chat.provider.requests.map((r) => r.label));
    expect(labels.has("narration_write_act")).toBe(true);
    expect(labels.has("narration-verify")).toBe(true);
    expect(anthropicCallCount() - before).toBe(0);
  });
});
