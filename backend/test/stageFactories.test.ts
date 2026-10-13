import Module from "node:module";
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from "vitest";
import {
  GENERATION_STAGES,
  RoutingConfigError,
  __resetStageRegistryForTests,
  __swapStageImplementationForTests,
  type StageBuildContext,
  type StageId,
  type StageImplementation
} from "../src/config/stageRouting";
import { createPromptUnderstander } from "../src/generation/createPromptUnderstander";
import { createExternalResearcher } from "../src/generation/createExternalResearcher";
import { createSpineBuilder } from "../src/generation/createSpineBuilder";
import { createDeepenActBuilder } from "../src/generation/createDeepenActBuilder";
import { createNarrationWriterBuilder } from "../src/generation/createNarrationWriterBuilder";
import { createNarrationVerifierBuilder } from "../src/generation/createNarrationVerifierBuilder";
import { createContinuityBuilder } from "../src/generation/createContinuityBuilder";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { NullExternalResearcher } from "../src/generation/NullExternalResearcher";
import { DossierExternalResearcher } from "../src/generation/DossierExternalResearcher";
import { ChatPromptUnderstander } from "../src/generation/chat/ChatPromptUnderstander";
import { ChatSpineBuilder } from "../src/generation/chat/ChatSpineBuilder";
import { ChatDeepenActBuilder } from "../src/generation/chat/ChatDeepenActBuilder";
import { ChatNarrationWriterBuilder } from "../src/generation/chat/ChatNarrationWriterBuilder";
import { ChatNarrationVerifierBuilder } from "../src/generation/chat/ChatNarrationVerifierBuilder";
import { ChatContinuityBuilder } from "../src/generation/chat/ChatContinuityBuilder";
import { __setChatProviderForTests, chatProviderFor, getChatProvider } from "../src/generation/chat/providerRegistry";
import { OpenAICompatChatProvider } from "../src/generation/chat/openAICompatProvider";
import { resolveRouting } from "../src/config/stageRouting";
import { scriptedProvider } from "./helpers/fakeChatProvider";
import { env } from "../src/config/env";
import { AnthropicPromptUnderstander } from "../src/generation/AnthropicPromptUnderstander";
import { AnthropicExternalResearcher } from "../src/generation/AnthropicExternalResearcher";
import { AnthropicSpineBuilder } from "../src/generation/AnthropicSpineBuilder";
import { AnthropicDeepenActBuilder } from "../src/generation/AnthropicDeepenActBuilder";
import { AnthropicNarrationWriterBuilder } from "../src/generation/AnthropicNarrationWriterBuilder";
import { AnthropicNarrationVerifierBuilder } from "../src/generation/AnthropicNarrationVerifierBuilder";
import { AnthropicContinuityBuilder } from "../src/generation/AnthropicContinuityBuilder";

/**
 * GV-37 (W2-08 + the factory half of W7-02; covers R2-21, HW-12, GP-06): the
 * seven stage factories pick stub, anthropic (legacy) or a Chat* builder on a
 * lane from the routing table, and a keyless local run fails fast instead of
 * silently stubbing.
 *
 * OFFLINE. Every case injects its env as a source (process.env is never
 * mutated), every local stage gets a scripted ChatProvider through
 * __setChatProviderForTests, and the 'anthropic' registration of every stage
 * is swapped for a sentinel, except in the one block that runs the REAL
 * 'anthropic' registrations: that block only constructs the Anthropic*
 * builders (an SDK client is built, no request is ever sent), so nothing
 * touches the network.
 */

const BASE_URL = "http://litellm.test:4000";

const ANTHROPIC_STAGES: StageId[] = GENERATION_STAGES.filter((s) => s !== "judge" && s !== "spine-alt");

interface Sentinel {
  sentinel: "anthropic";
  stage: StageId;
  model: string;
}

function anthropicSentinel(): StageImplementation<Sentinel> {
  return {
    create: (ctx: StageBuildContext) => ({ sentinel: "anthropic", stage: ctx.stage, model: ctx.route.model }),
    describe: (ctx: StageBuildContext) => ({ model: ctx.route.model })
  };
}

/** Every factory, called once against `source`. */
function buildAll(source: NodeJS.ProcessEnv) {
  return {
    understander: createPromptUnderstander(source),
    researcher: createExternalResearcher(source),
    spine: createSpineBuilder(source),
    deepen: createDeepenActBuilder(source),
    writer: createNarrationWriterBuilder(source),
    verifier: createNarrationVerifierBuilder(source),
    continuity: createContinuityBuilder(source)
  };
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

let restores: Array<() => void> = [];
const provider = scriptedProvider({ complete: (req) => JSON.stringify({ nextIntroduction: `reply to ${req.label}` }) });

beforeEach(() => {
  restores = ANTHROPIC_STAGES.map((stage) => __swapStageImplementationForTests(stage, "anthropic", anthropicSentinel()));
  __setChatProviderForTests(provider);
  provider.requests.length = 0;
});

afterEach(() => {
  for (const restore of restores) restore();
  __setChatProviderForTests(undefined);
});

describe("GV-37: without the routing variables every factory returns what it returns today", () => {
  /* MUTATION THAT KILLS THIS: have a factory's 'stub' registration build
     something other than its Stub. Ran on createSpineBuilder: red. */
  it("no key, no FORAY_LLM_BASE_URL: every stage is its Stub", () => {
    const all = buildAll({});
    expect(all.understander).toBeInstanceOf(StubPromptUnderstander);
    expect(all.researcher).toBeInstanceOf(StubExternalResearcher);
    expect(all.spine).toBeInstanceOf(StubSpineBuilder);
    expect(all.deepen).toBeInstanceOf(StubDeepenActBuilder);
    expect(all.writer).toBeInstanceOf(StubNarrationWriterBuilder);
    expect(all.verifier).toBeInstanceOf(StubNarrationVerifierBuilder);
    expect(all.continuity).toBeInstanceOf(StubContinuityBuilder);
  });

  /* GV-68: ANTHROPIC_API_KEY alone selects the Stub now (stageRouting.test.ts);
     the legacy builders need both explicit opt-ins. */
  it("the two legacy opt-ins: every stage is the legacy (anthropic) implementation on its tier", () => {
    const all = buildAll({ FORAY_GENERATION_MODE: "anthropic-legacy", FORAY_ALLOW_ANTHROPIC_LEGACY: "1", ANTHROPIC_API_KEY: "sk-test" });
    const stages: Record<keyof typeof all, StageId> = {
      understander: "understand.intent",
      researcher: "research",
      spine: "spine",
      deepen: "deepen",
      writer: "writer",
      verifier: "verifier",
      continuity: "continuity"
    };
    for (const [name, stage] of Object.entries(stages) as Array<[keyof typeof all, StageId]>) {
      expect(all[name], name).toMatchObject({ sentinel: "anthropic", stage });
    }
    expect(provider.requests).toHaveLength(0);
  });
});

describe("GV-37: the real legacy 'anthropic' registrations (no sentinel)", () => {
  /* The sentinel swaps from the top-level beforeEach are undone here so the
     factories' own 'anthropic' closures run, lazy require() and all.
     Two test-only adjustments, neither of which replaces the closure:
     - Under vitest a bare require("./AnthropicX") cannot resolve a .ts file
       (the compiled build resolves the .js). Module._load is patched for
       exactly these seven request strings to hand back the module vitest
       already loaded, the same module the static imports above name, so
       toBeInstanceOf compares against the class the closure constructed.
       Any other request string (a mutated or misspelled require) falls
       through to Node and fails.
     - The Anthropic* constructors read the module-level env (not the
       injected source), so the key is set on env for the block and restored
       after.
     Constructing builds an SDK client only; no method is called, so no
     request is sent.
     MUTATIONS THAT KILL THIS: createSpineBuilder's 'anthropic' closure
     returning `new StubSpineBuilder()` (red); createDeepenActBuilder's
     returning a StubDeepenActBuilder (red). */
  const lazyModules: Record<string, unknown> = {
    "./AnthropicPromptUnderstander": { AnthropicPromptUnderstander },
    "./AnthropicExternalResearcher": { AnthropicExternalResearcher },
    "./AnthropicSpineBuilder": { AnthropicSpineBuilder },
    "./AnthropicDeepenActBuilder": { AnthropicDeepenActBuilder },
    "./AnthropicNarrationWriterBuilder": { AnthropicNarrationWriterBuilder },
    "./AnthropicNarrationVerifierBuilder": { AnthropicNarrationVerifierBuilder },
    "./AnthropicContinuityBuilder": { AnthropicContinuityBuilder }
  };
  type Loader = (request: string, parent: unknown, isMain: boolean) => unknown;
  const moduleInternals = Module as unknown as { _load: Loader };
  let originalLoad: Loader;
  let savedKey: string | undefined;

  beforeAll(() => {
    originalLoad = moduleInternals._load;
    moduleInternals._load = function (this: unknown, request, parent, isMain) {
      if (Object.prototype.hasOwnProperty.call(lazyModules, request)) return lazyModules[request];
      return originalLoad.call(this, request, parent, isMain);
    };
  });

  afterAll(() => {
    moduleInternals._load = originalLoad;
  });

  beforeEach(() => {
    for (const restore of restores) restore();
    restores = [];
    savedKey = env.anthropicApiKey;
    env.anthropicApiKey = "sk-test-never-sent";
  });

  afterEach(() => {
    env.anthropicApiKey = savedKey;
  });

  it("the two legacy opt-ins and no stage variables: every factory builds its Anthropic class", () => {
    const all = buildAll({ FORAY_GENERATION_MODE: "anthropic-legacy", FORAY_ALLOW_ANTHROPIC_LEGACY: "1", ANTHROPIC_API_KEY: "sk-test-never-sent" });
    expect(all.understander).toBeInstanceOf(AnthropicPromptUnderstander);
    expect(all.researcher).toBeInstanceOf(AnthropicExternalResearcher);
    expect(all.spine).toBeInstanceOf(AnthropicSpineBuilder);
    expect(all.deepen).toBeInstanceOf(AnthropicDeepenActBuilder);
    expect(all.writer).toBeInstanceOf(AnthropicNarrationWriterBuilder);
    expect(all.verifier).toBeInstanceOf(AnthropicNarrationVerifierBuilder);
    expect(all.continuity).toBeInstanceOf(AnthropicContinuityBuilder);
    expect(provider.requests).toHaveLength(0);
  });

  it("one stage moved to a local lane leaves the other six on their real Anthropic classes", () => {
    const all = buildAll({ ANTHROPIC_API_KEY: "sk-test-never-sent", FORAY_LLM_BASE_URL: BASE_URL, FORAY_GENERATION_MODE: "anthropic-legacy", FORAY_ALLOW_ANTHROPIC_LEGACY: "1", FORAY_STAGE_SPINE: "local:spark" });
    expect(all.spine).toBeInstanceOf(ChatSpineBuilder);
    expect(all.understander).toBeInstanceOf(AnthropicPromptUnderstander);
    expect(all.researcher).toBeInstanceOf(AnthropicExternalResearcher);
    expect(all.deepen).toBeInstanceOf(AnthropicDeepenActBuilder);
    expect(all.writer).toBeInstanceOf(AnthropicNarrationWriterBuilder);
    expect(all.verifier).toBeInstanceOf(AnthropicNarrationVerifierBuilder);
    expect(all.continuity).toBeInstanceOf(AnthropicContinuityBuilder);
  });
});

describe("GV-37: one stage moves to a local lane", () => {
  /* MUTATION THAT KILLS THIS: restore createSpineBuilder's old
     `env.anthropicDryRun ? Stub : Anthropic` body. Ran: red (the spine is
     the sentinel, not a ChatSpineBuilder). */
  it("FORAY_LLM_BASE_URL + FORAY_STAGE_SPINE=local:spark under the legacy mode: only the spine is a Chat builder", () => {
    const all = buildAll({
      ANTHROPIC_API_KEY: "sk-test",
      FORAY_GENERATION_MODE: "anthropic-legacy",
      FORAY_ALLOW_ANTHROPIC_LEGACY: "1",
      FORAY_LLM_BASE_URL: BASE_URL,
      FORAY_STAGE_SPINE: "local:spark"
    });
    expect(all.spine).toBeInstanceOf(ChatSpineBuilder);
    expect(all.spine.providerName).toBe("local:spark");
    for (const name of ["understander", "researcher", "deepen", "writer", "verifier", "continuity"] as const) {
      expect(all[name], name).toMatchObject({ sentinel: "anthropic" });
    }
  });

  it("the same override in a keyless (stub) run leaves every other stage a Stub", () => {
    const all = buildAll({ FORAY_GENERATION_MODE: "stub", FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_SPINE: "local:second" });
    expect(all.spine).toBeInstanceOf(ChatSpineBuilder);
    expect(all.spine.providerName).toBe("local:second");
    expect(all.deepen).toBeInstanceOf(StubDeepenActBuilder);
    expect(all.writer).toBeInstanceOf(StubNarrationWriterBuilder);
  });

  it("FORAY_STAGE_WRITER=stub in a legacy run: the writer is the Stub, the rest resolve as before", () => {
    const all = buildAll({ FORAY_GENERATION_MODE: "anthropic-legacy", FORAY_ALLOW_ANTHROPIC_LEGACY: "1", ANTHROPIC_API_KEY: "sk-test", FORAY_STAGE_WRITER: "stub" });
    expect(all.writer).toBeInstanceOf(StubNarrationWriterBuilder);
    for (const name of ["understander", "researcher", "spine", "deepen", "verifier", "continuity"] as const) {
      expect(all[name], name).toMatchObject({ sentinel: "anthropic" });
    }
  });
});

describe("GV-37: local mode", () => {
  /* MUTATION THAT KILLS THIS: drop the 'none' registration from
     createExternalResearcher. Ran: red (RoutingConfigError: no
     implementation is registered for the routed id on stage "research"). */
  it("FORAY_GENERATION_MODE=local: every model stage is a Chat builder on its default lane, research is 'none'", () => {
    const all = buildAll({ FORAY_GENERATION_MODE: "local", FORAY_LLM_BASE_URL: BASE_URL });
    expect(all.understander).toBeInstanceOf(ChatPromptUnderstander);
    expect(all.spine).toBeInstanceOf(ChatSpineBuilder);
    expect(all.deepen).toBeInstanceOf(ChatDeepenActBuilder);
    expect(all.writer).toBeInstanceOf(ChatNarrationWriterBuilder);
    expect(all.verifier).toBeInstanceOf(ChatNarrationVerifierBuilder);
    expect(all.continuity).toBeInstanceOf(ChatContinuityBuilder);
    expect({
      understander: all.understander.providerName,
      spine: all.spine.providerName,
      deepen: all.deepen.providerName,
      writer: all.writer.providerName,
      verifier: all.verifier.providerName,
      continuity: all.continuity.providerName
    }).toEqual({
      understander: "local:spark",
      spine: "local:spark",
      deepen: "local:second",
      writer: "local:spark",
      verifier: "local:spark",
      continuity: "local:spark"
    });
    expect(all.researcher).toBeInstanceOf(NullExternalResearcher);
    expect(all.researcher.providerName).toBe("none");
  });

  it("FORAY_LLM_BASE_URL alone infers local mode, with no ANTHROPIC_API_KEY needed", () => {
    const all = buildAll({ FORAY_LLM_BASE_URL: BASE_URL });
    expect(all.spine).toBeInstanceOf(ChatSpineBuilder);
    expect(all.researcher).toBeInstanceOf(NullExternalResearcher);
  });

  /* MUTATION THAT KILLS THIS: have localImplementation send the lane id
     instead of the route's model alias (targetFor's model swapped). Ran:
     red (the request named 'spark', not 'local-heavy'). */
  it("a local builder asks the process ChatProvider with its lane's model alias and schema", async () => {
    const continuity = createContinuityBuilder({ FORAY_GENERATION_MODE: "local", FORAY_LLM_BASE_URL: BASE_URL });
    const result = await continuity.smoothSeam(
      { previousActExit: "The siege ended.", previousActTitle: "Siege", nextActIntroduction: "Then came peace.", nextActTitle: "Peace" },
      { userId: "test-user" }
    );
    expect(result.nextIntroduction).toBe("reply to continuity-smooth");
    expect(provider.requests).toHaveLength(1);
    expect(provider.requests[0]!.model).toBe("local-heavy");
    expect(provider.requests[0]!.responseFormat).toMatchObject({ type: "json_schema" });
  });

  it("NullExternalResearcher resolves an empty result with no retrieval", async () => {
    const researcher = createExternalResearcher({ FORAY_GENERATION_MODE: "local", FORAY_LLM_BASE_URL: BASE_URL });
    await expect(researcher.research("Roman siege weapons", { userId: "test-user" })).resolves.toEqual({ notes: "", controversies: [] });
    expect(researcher.retrievePassages).toBeUndefined();
  });

  it("every call builds a fresh instance: the writer and the verifier never share one", () => {
    const source = { FORAY_GENERATION_MODE: "local", FORAY_LLM_BASE_URL: BASE_URL };
    expect(createSpineBuilder(source)).not.toBe(createSpineBuilder(source));
    expect(createNarrationWriterBuilder(source)).not.toBe(createNarrationVerifierBuilder(source) as unknown);
  });
});

describe("GV-37: a misrouted local stage fails fast, never a Stub", () => {
  /* MUTATION THAT KILLS THIS: catch RoutingConfigError in a factory and
     return the Stub. Ran on createSpineBuilder: red. */
  it("a stage routed 'local' without FORAY_LLM_BASE_URL throws RoutingConfigError naming the variable", () => {
    const factories = [
      createPromptUnderstander,
      createExternalResearcher,
      createSpineBuilder,
      createDeepenActBuilder,
      createNarrationWriterBuilder,
      createNarrationVerifierBuilder,
      createContinuityBuilder
    ];
    for (const factory of factories) {
      const err = thrown(() => factory({ ANTHROPIC_API_KEY: "sk-test", FORAY_STAGE_SPINE: "local" }));
      expect(err, factory.name).toBeInstanceOf(RoutingConfigError);
      expect((err as RoutingConfigError).variable).toBe("FORAY_LLM_BASE_URL");
    }
    const modeErr = thrown(() => createSpineBuilder({ FORAY_GENERATION_MODE: "local" }));
    expect(modeErr).toBeInstanceOf(RoutingConfigError);
  });

  /* GV-69: the dossier researcher is registered now, so the route builds it
     (resolveRouting's not-built refusal is held in stageRouting.test.ts with
     an empty registry). Mutation: drop the 'dossier' built-in. Ran: red. */
  it("research routed 'dossier' builds the dossier researcher (GV-69)", () => {
    expect(createExternalResearcher({ FORAY_STAGE_RESEARCH: "dossier" })).toBeInstanceOf(DossierExternalResearcher);
  });

  it("a reset registry is re-registered on the next factory call", () => {
    __resetStageRegistryForTests();
    expect(createSpineBuilder({})).toBeInstanceOf(StubSpineBuilder);
    expect(createExternalResearcher({ FORAY_STAGE_RESEARCH: "none" })).toBeInstanceOf(NullExternalResearcher);
  });
});

describe("GV-37: the understander's three routes", () => {
  /* MUTATION THAT KILLS THIS: SplitPromptUnderstander.assessClarity
     delegating to the intent half. Ran: red (the clarity call went to the
     local Chat understander, not the Stub). */
  it("a clarity route that differs from the intent route answers assessClarity on its own implementation", async () => {
    const understander = createPromptUnderstander({
      FORAY_GENERATION_MODE: "local",
      FORAY_LLM_BASE_URL: BASE_URL,
      FORAY_STAGE_UNDERSTAND_CLARITY: "stub"
    });
    expect(understander.providerName).toBe("local:spark (clarity: stub)");
    const clarity = await understander.assessClarity("Roman siege weapons", { userId: "test-user" });
    expect(clarity.ambiguous).toBe(false);
    expect(provider.requests).toHaveLength(0);
  });

  /* MUTATION THAT KILLS THIS: drop the title-route check. Ran: red. */
  it("a title route that differs from the intent route throws, naming FORAY_STAGE_UNDERSTAND_TITLE", () => {
    const err = thrown(() =>
      createPromptUnderstander({ FORAY_GENERATION_MODE: "local", FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_UNDERSTAND_TITLE: "stub" })
    );
    expect(err).toBeInstanceOf(RoutingConfigError);
    expect((err as RoutingConfigError).variable).toBe("FORAY_STAGE_UNDERSTAND_TITLE");
  });
});

describe("GV-37: providerRegistry", () => {
  beforeEach(() => __setChatProviderForTests(undefined));

  /* MUTATION THAT KILLS THIS: always return the first cached provider
     whatever the config. Ran: red. */
  it("builds one OpenAI-compatible provider per config and reuses it, with no network", () => {
    const a = getChatProvider({ baseUrl: BASE_URL, apiKey: "k1" });
    expect(a).toBeInstanceOf(OpenAICompatChatProvider);
    expect(getChatProvider({ baseUrl: BASE_URL, apiKey: "k1" })).toBe(a);
    const b = getChatProvider({ baseUrl: BASE_URL, apiKey: "k2" });
    expect(b).not.toBe(a);
  });

  it("refuses a missing base URL, naming the variable and never a value", () => {
    const err = thrown(() => getChatProvider({ baseUrl: null, apiKey: "secret-key" }));
    expect(err).toBeInstanceOf(RoutingConfigError);
    expect((err as RoutingConfigError).variable).toBe("FORAY_LLM_BASE_URL");
    expect(err.message).not.toContain("secret-key");
  });

  it("chatProviderFor reads the key from the source it is given", () => {
    const source = { FORAY_LLM_BASE_URL: BASE_URL, FORAY_LLM_API_KEY: "k3" };
    const routing = resolveRouting(source);
    expect(chatProviderFor(routing, source)).toBe(getChatProvider({ baseUrl: BASE_URL, apiKey: "k3" }));
  });

  it("the test seam wins over the cached provider", () => {
    const scripted = scriptedProvider({ complete: [] });
    __setChatProviderForTests(scripted);
    expect(getChatProvider({ baseUrl: BASE_URL, apiKey: "k1" })).toBe(scripted);
  });
});
