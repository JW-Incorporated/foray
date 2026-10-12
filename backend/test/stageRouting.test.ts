import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import { resolveModelId, type ModelTier } from "../src/config/models";
import { DEFAULT_LANE_PROFILES, mergeLaneProfiles } from "../src/config/machineProfiles";
import {
  GENERATION_STAGES,
  RoutingConfigError,
  StageRegistry,
  __resetStageRegistryForTests,
  __swapStageImplementationForTests,
  describeStageAssignments,
  instantiateStage,
  isStageImplementationRegistered,
  registerStageImplementation,
  resolveLlmApiKey,
  resolveRouting,
  routeFor,
  routingSummary,
  stageEnvVar,
  type StageId,
  type StageImplementation
} from "../src/config/stageRouting";

/**
 * GV-03 (W2-05 + the registry half of W7-02): one per-stage switch,
 * FORAY_STAGE_<STAGE>=<impl>[:<lane>], over a generation mode. Every case
 * drives the pure resolver with an injected source, the same pattern as
 * models.ts resolveModelId(tier, source); process.env is never mutated.
 */

const BASE_URL = "http://litellm.test:4000";
const SRC = path.resolve(__dirname, "..", "src", "generation");

/** The builder each legacy stage runs today (create*.ts's lazy require). */
const LEGACY_BUILDER: Partial<Record<StageId, string>> = {
  "understand.clarity": "AnthropicPromptUnderstander.ts",
  "understand.intent": "AnthropicPromptUnderstander.ts",
  "understand.title": "AnthropicPromptUnderstander.ts",
  research: "AnthropicExternalResearcher.ts",
  spine: "AnthropicSpineBuilder.ts",
  deepen: "AnthropicDeepenActBuilder.ts",
  writer: "AnthropicNarrationWriterBuilder.ts",
  verifier: "AnthropicNarrationVerifierBuilder.ts",
  continuity: "AnthropicContinuityBuilder.ts"
};

/** The tier a builder file passes to modelFor(...) today. */
function tierInSource(file: string): ModelTier {
  const text = fs.readFileSync(path.join(SRC, file), "utf8");
  const m = /const MODEL = modelFor\("(opus|sonnet|haiku)"\)/.exec(text);
  if (!m) throw new Error(`no modelFor(...) line in ${file}`);
  return m[1] as ModelTier;
}

function thrown(fn: () => unknown): Error {
  try {
    fn();
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw");
}

const profiles = DEFAULT_LANE_PROFILES;
const resolve = (source: NodeJS.ProcessEnv) => resolveRouting(source, { profiles, registry: new StageRegistry() });

function sentinel(name: string): StageImplementation<{ name: string; lane?: string }> {
  return {
    create: (ctx) => ({ name, ...(ctx.route.lane ? { lane: ctx.route.lane } : {}) }),
    describe: (ctx) => ({ model: `${name}-model`, ...(ctx.route.lane ? { machine: `${ctx.route.lane}-box` } : {}) })
  };
}

describe("stageRouting — today's choice is the default (GV-03)", () => {
  it("lists the ten W2-05 stages plus 'spine-alt', and names each variable", () => {
    expect([...GENERATION_STAGES].sort()).toEqual(
      ["understand.clarity", "understand.intent", "understand.title", "research", "spine", "spine-alt", "deepen", "writer", "verifier", "continuity", "judge"].sort()
    );
    expect(stageEnvVar("understand.clarity")).toBe("FORAY_STAGE_UNDERSTAND_CLARITY");
    expect(stageEnvVar("spine-alt")).toBe("FORAY_STAGE_SPINE_ALT");
    expect(stageEnvVar("writer")).toBe("FORAY_STAGE_WRITER");
  });

  /* Mutation: default stub mode to 'anthropic' (or the judge to 'stub') and
     this fails. */
  it("with nothing set, every stage is the Stub, as with no ANTHROPIC_API_KEY today", () => {
    for (const source of [{}, { ANTHROPIC_API_KEY: "   " }]) {
      const table = resolve(source);
      expect(table.mode).toBe("stub");
      for (const stage of GENERATION_STAGES) {
        if (stage === "spine-alt") expect(table.routes[stage]).toBeUndefined();
        else if (stage === "judge") expect(table.routes[stage]).toEqual({ provider: "none", model: "none" });
        else expect(table.routes[stage]).toEqual({ provider: "stub", model: "stub" });
      }
    }
  });

  /* Mutation: change LEGACY_TIERS.deepen to 'opus' (or route research to
     sonnet) and the builder's own modelFor line disagrees. */
  it("with only ANTHROPIC_API_KEY, every stage runs today's Anthropic builder on its models.ts tier", () => {
    const source = { ANTHROPIC_API_KEY: "sk-ant-test" };
    const table = resolve(source);
    expect(table.mode).toBe("anthropic-legacy");
    expect(table.modeSource).toBe("ANTHROPIC_API_KEY");
    for (const [stage, file] of Object.entries(LEGACY_BUILDER) as [StageId, string][]) {
      const tier = tierInSource(file);
      expect(table.routes[stage], stage).toEqual({ provider: "anthropic", tier, model: resolveModelId(tier, source) });
    }
    expect(table.routes.judge).toEqual({ provider: "none", model: "none" });
    expect(table.routes["spine-alt"]).toBeUndefined();
  });

  /* Mutation: resolve the legacy model with resolveModelId(tier) (process.env)
     instead of the injected source and the override is ignored. */
  it("FORAY_MODEL_SONNET still swaps the same four stages it swaps today", () => {
    const table = resolve({ ANTHROPIC_API_KEY: "k", FORAY_MODEL_SONNET: "sonnet-pinned-snapshot" });
    const swapped = GENERATION_STAGES.filter((s) => table.routes[s]?.model === "sonnet-pinned-snapshot");
    expect(swapped.sort()).toEqual(["continuity", "deepen", "verifier", "writer"]);
  });
});

describe("stageRouting — local mode and per-stage overrides (GV-03)", () => {
  /* Mutation: move deepen's local default to spark, or research to 'stub',
     and this fails. */
  it("with FORAY_LLM_BASE_URL set, every stage resolves to the documented local default", () => {
    const table = resolve({ FORAY_LLM_BASE_URL: BASE_URL, ANTHROPIC_API_KEY: "ignored-for-mode" });
    expect(table.mode).toBe("local");
    expect(table.modeSource).toBe("FORAY_LLM_BASE_URL");
    const spark = { provider: "local", lane: "spark", model: "local-heavy" };
    for (const stage of ["understand.clarity", "understand.intent", "understand.title", "spine", "writer", "verifier", "continuity"] as const) {
      expect(table.routes[stage], stage).toEqual(spark);
    }
    expect(table.routes.deepen).toEqual({ provider: "local", lane: "second", model: "local-worker" });
    expect(table.routes.research).toEqual({ provider: "none", model: "none" });
    expect(table.routes.judge).toEqual({ provider: "jev", model: "jev", fallback: { provider: "local", lane: "second", model: "local-worker" } });
    expect(table.routes["spine-alt"]).toBeUndefined();
  });

  /* Mutation: apply an override to every stage (or to none) and the
     comparison fails. */
  it("FORAY_STAGE_SPINE=local:second moves only the spine", () => {
    const base = resolve({ FORAY_LLM_BASE_URL: BASE_URL });
    const moved = resolve({ FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_SPINE: "local:second" });
    expect(moved.routes.spine).toEqual({ provider: "local", lane: "second", model: "local-worker" });
    for (const stage of GENERATION_STAGES) {
      if (stage !== "spine") expect(moved.routes[stage], stage).toEqual(base.routes[stage]);
    }
    expect(moved.overridden).toEqual(["spine"]);
  });

  /* Mutation: ignore FORAY_STAGE_* outside local mode and the writer stays
     anthropic. */
  it("an override applies in any mode: FORAY_STAGE_WRITER=stub beside a key", () => {
    const table = resolve({ ANTHROPIC_API_KEY: "k", FORAY_STAGE_WRITER: "stub" });
    expect(table.routes.writer).toEqual({ provider: "stub", model: "stub" });
    expect(table.routes.spine?.provider).toBe("anthropic");
  });

  /* Mutation: make `local` with no lane always pick spark and deepen lands on
     the Spark. */
  it("'local' without a lane takes the stage's default lane; FORAY_GENERATION_MODE wins over inference", () => {
    const table = resolve({ FORAY_GENERATION_MODE: "stub", FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_DEEPEN: "local", FORAY_STAGE_SPINE: "local" });
    expect(table.mode).toBe("stub");
    expect(table.routes.deepen?.lane).toBe("second");
    expect(table.routes.spine?.lane).toBe("spark");
    expect(table.routes.writer?.provider).toBe("stub");
  });

  /* Mutation: build `fallback` only for the local-mode default and an explicit
     jev:second loses it. */
  it("a jev route may name its fallback lane; plain jev has none", () => {
    expect(resolve({ FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_JUDGE: "jev" }).routes.judge).toEqual({ provider: "jev", model: "jev" });
    expect(resolve({ FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_VERIFIER: "jev:second" }).routes.verifier?.fallback).toEqual({
      provider: "local",
      lane: "second",
      model: "local-worker"
    });
  });

  /* Mutation: read modelAlias from DEFAULT_LANE_PROFILES instead of the
     injected profiles and the alias does not move. */
  it("a profile override reaches the routes (the alias comes from the profile)", () => {
    const custom = mergeLaneProfiles({ spark: { modelAlias: "foray-only" } });
    const table = resolveRouting({ FORAY_LLM_BASE_URL: BASE_URL }, { profiles: custom, registry: new StageRegistry() });
    expect(table.routes.spine?.model).toBe("foray-only");
  });
});

describe("stageRouting — refusals name the variable, never the value (GV-03)", () => {
  /* Mutation: delete the allowsProse check and the writer lands on the
     second box. */
  it("a writer on a lane without prose throws naming the prose rule, unless FORAY_ALLOW_PROSE_ON_SECOND=1", () => {
    const err = thrown(() => resolve({ FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_WRITER: "local:second" }));
    expect(err).toBeInstanceOf(RoutingConfigError);
    expect((err as RoutingConfigError).variable).toBe("FORAY_STAGE_WRITER");
    expect(err.message).toContain("allowsProse");
    expect(err.message).toContain("FORAY_ALLOW_PROSE_ON_SECOND=1");
    const allowed = resolve({ FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_WRITER: "local:second", FORAY_ALLOW_PROSE_ON_SECOND: "1" });
    expect(allowed.routes.writer?.lane).toBe("second");
    expect(() => resolve({ FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_WRITER: "local:second", FORAY_ALLOW_PROSE_ON_SECOND: "yes" })).toThrow(/FORAY_ALLOW_PROSE_ON_SECOND/);
  });

  /* Mutation: test `lane === "second"` instead of the profile's allowsProse
     and a prose-less Spark (after the OQ-01 edit) slips through. */
  it("the prose rule reads the profile, not the lane's name", () => {
    const noProse = mergeLaneProfiles({ spark: { allowsProse: false } });
    expect(() => resolveRouting({ FORAY_LLM_BASE_URL: BASE_URL }, { profiles: noProse, registry: new StageRegistry() })).toThrow(RoutingConfigError);
  });

  /* Mutation: drop the FORAY_LLM_BASE_URL check and a keyless local route
     resolves (GV-37 would then build a provider with no URL). */
  it("a local route without FORAY_LLM_BASE_URL throws naming it", () => {
    for (const source of [{ FORAY_GENERATION_MODE: "local" }, { FORAY_STAGE_SPINE: "local:spark" }, { FORAY_STAGE_JUDGE: "jev:second" }]) {
      const err = thrown(() => resolve(source));
      expect(err).toBeInstanceOf(RoutingConfigError);
      expect((err as RoutingConfigError).variable).toBe("FORAY_LLM_BASE_URL");
    }
  });

  /* Mutation: echo `raw` in unknownValue's message, or accept any provider on
     any stage, and one of these fails. */
  it("an unknown FORAY_STAGE_* value throws naming the variable without echoing it", () => {
    const cases: [string, string][] = [
      ["FORAY_STAGE_SPINE", "qwenSecretXyz"],
      ["FORAY_STAGE_SPINE", "local:third"],
      ["FORAY_STAGE_SPINE", "none"],
      ["FORAY_STAGE_SPINE", "stub:spark"],
      ["FORAY_STAGE_SPINE", "Local"],
      ["FORAY_STAGE_WRITER", "jev"],
      ["FORAY_STAGE_JUDGE", "anthropic"],
      ["FORAY_STAGE_RESEARCH", "local"],
      ["FORAY_STAGE_UNDERSTAND_CLARITY", "local:spark:extra"]
    ];
    for (const [variable, value] of cases) {
      const err = thrown(() => resolve({ FORAY_LLM_BASE_URL: BASE_URL, [variable]: value }));
      expect(err, `${variable}=${value}`).toBeInstanceOf(RoutingConfigError);
      expect((err as RoutingConfigError).variable).toBe(variable);
      expect(err.message).toContain(variable);
      expect(err.message).not.toContain(value);
    }
  });

  /* Mutation: accept any FORAY_GENERATION_MODE string. */
  it("an unknown FORAY_GENERATION_MODE or a malformed FORAY_LLM_BASE_URL throws naming the variable", () => {
    const mode = thrown(() => resolve({ FORAY_GENERATION_MODE: "turboMode77" }));
    expect((mode as RoutingConfigError).variable).toBe("FORAY_GENERATION_MODE");
    expect(mode.message).not.toContain("turboMode77");
    const url = thrown(() => resolve({ FORAY_LLM_BASE_URL: "not a url secretHost" }));
    expect((url as RoutingConfigError).variable).toBe("FORAY_LLM_BASE_URL");
    expect(url.message).not.toContain("secretHost");
    expect(() => resolve({ FORAY_LLM_BASE_URL: "ftp://litellm.test" })).toThrow(RoutingConfigError);
  });

  /* Mutation: drop the dossier registration check and 'dossier' resolves
     before the dossier researcher exists. */
  it("'dossier' throws 'not built' until an implementation registers it", () => {
    const empty = new StageRegistry();
    const err = thrown(() => resolveRouting({ FORAY_STAGE_RESEARCH: "dossier" }, { profiles, registry: empty }));
    expect((err as RoutingConfigError).variable).toBe("FORAY_STAGE_RESEARCH");
    expect(err.message).toContain("not built");
    const withDossier = new StageRegistry();
    withDossier.register("research", "dossier", sentinel("dossier"));
    expect(resolveRouting({ FORAY_STAGE_RESEARCH: "dossier" }, { profiles, registry: withDossier }).routes.research).toEqual({
      provider: "dossier",
      model: "dossier"
    });
  });
});

describe("stageRouting — logging and the LiteLLM key (GV-03)", () => {
  /* Mutation: put llmBaseUrl into the summary unredacted, or a key field, and
     a secret appears in the JSON. */
  it("routingSummary never contains a key or URL credentials", () => {
    const source = {
      FORAY_LLM_BASE_URL: "http://user:urlPassw0rd@litellm.test:4000/v1?token=qsSecret",
      FORAY_LLM_API_KEY: "sk-litellm-SECRET1",
      ANTHROPIC_API_KEY: "sk-ant-SECRET2",
      FORAY_STAGE_SPINE: "local:second"
    };
    const summary = routingSummary(resolve(source));
    const json = JSON.stringify(summary);
    for (const secret of ["sk-litellm-SECRET1", "sk-ant-SECRET2", "urlPassw0rd", "qsSecret", "user:"]) {
      expect(json).not.toContain(secret);
    }
    expect(summary.llm).toEqual({ baseUrl: "http://litellm.test:4000/v1", keyConfigured: true });
    expect(summary.stages.spine).toBe("local:second local-worker");
    expect(summary.stages.writer).toBe("local:spark local-heavy");
    expect(summary.stages.judge).toBe("jev (fallback local:second local-worker)");
    expect(summary.mode).toBe("local");
    expect(summary.overridden).toEqual(["spine"]);
  });

  /* Mutation: read the key file before FORAY_LLM_API_KEY, or let the read
     error escape (it carries the path). */
  it("the key comes from FORAY_LLM_API_KEY, else FORAY_LLM_API_KEY_FILE", () => {
    const readFile = (p: string) => (p === "C:/keys/litellm" ? "  sk-from-file\n" : "");
    expect(resolveLlmApiKey({}, readFile)).toBeUndefined();
    expect(resolveLlmApiKey({ FORAY_LLM_API_KEY: "sk-direct", FORAY_LLM_API_KEY_FILE: "C:/keys/litellm" }, readFile)).toBe("sk-direct");
    expect(resolveLlmApiKey({ FORAY_LLM_API_KEY_FILE: "C:/keys/litellm" }, readFile)).toBe("sk-from-file");
    const empty = thrown(() => resolveLlmApiKey({ FORAY_LLM_API_KEY_FILE: "C:/keys/empty" }, readFile));
    expect((empty as RoutingConfigError).variable).toBe("FORAY_LLM_API_KEY_FILE");
    const missing = thrown(() =>
      resolveLlmApiKey({ FORAY_LLM_API_KEY_FILE: "C:/keys/hiddenPathXyz" }, () => {
        throw new Error("ENOENT C:/keys/hiddenPathXyz");
      })
    );
    expect((missing as RoutingConfigError).variable).toBe("FORAY_LLM_API_KEY_FILE");
    expect(missing.message).not.toContain("hiddenPathXyz");
  });
});

describe("stageRouting — implementation registry (GV-03, from W7-02)", () => {
  beforeEach(() => __resetStageRegistryForTests());
  afterEach(() => __resetStageRegistryForTests());

  /* Mutation: return `undefined` for an unregistered id instead of throwing,
     or put the provider id into the message. */
  it("instantiating an unregistered implementation throws naming the variable, not the value", () => {
    registerStageImplementation("spine", "stub", sentinel("stub-spine"));
    const err = thrown(() => instantiateStage("spine", { source: { FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_SPINE: "local:second" } }));
    expect(err).toBeInstanceOf(RoutingConfigError);
    expect((err as RoutingConfigError).variable).toBe("FORAY_STAGE_SPINE");
    expect(err.message).not.toContain("local");
    expect(err.message).not.toContain("second");
  });

  /* Mutation: let a second register overwrite the first. */
  it("registerStageImplementation refuses a duplicate id and an id the stage cannot take", () => {
    registerStageImplementation("writer", "local", sentinel("one"));
    expect(() => registerStageImplementation("writer", "local", sentinel("two"))).toThrow(/already registered/);
    expect(() => registerStageImplementation("spine", "none", sentinel("x"))).toThrow(RoutingConfigError);
    expect(() => registerStageImplementation("judge", "anthropic", sentinel("x"))).toThrow(RoutingConfigError);
    expect(isStageImplementationRegistered("writer", "local")).toBe(true);
    expect(isStageImplementationRegistered("writer", "stub")).toBe(false);
  });

  /* Mutation: give 'spine-alt' a default in defaultSpec and it resolves
     without being set. */
  it("'spine-alt' resolves to nothing unless set", () => {
    registerStageImplementation("spine-alt", "local", sentinel("alt"));
    expect(routeFor("spine-alt", { FORAY_LLM_BASE_URL: BASE_URL }, { profiles })).toBeUndefined();
    const unset = thrown(() => instantiateStage("spine-alt", { source: { FORAY_LLM_BASE_URL: BASE_URL } }));
    expect((unset as RoutingConfigError).variable).toBe("FORAY_STAGE_SPINE_ALT");
    expect(instantiateStage("spine-alt", { source: { FORAY_LLM_BASE_URL: BASE_URL, FORAY_STAGE_SPINE_ALT: "local:second" } })).toEqual({
      name: "alt",
      lane: "second"
    });
  });

  /* Mutation: instantiate by the stage's default instead of the route, and
     the stub comes back for the overridden writer. */
  it("instantiateStage builds what the route picks, with the lane's profile in context", () => {
    let seenProfile: unknown;
    registerStageImplementation("writer", "stub", sentinel("stub-writer"));
    registerStageImplementation("writer", "local", {
      create: (ctx) => {
        seenProfile = ctx.profile;
        return { name: "chat-writer" };
      },
      describe: () => ({ model: "m" })
    });
    expect(instantiateStage("writer", { source: {} })).toEqual({ name: "stub-writer" });
    expect(instantiateStage("writer", { source: { FORAY_LLM_BASE_URL: BASE_URL } })).toEqual({ name: "chat-writer" });
    expect(seenProfile).toEqual(DEFAULT_LANE_PROFILES.spark);
  });

  /* Mutation: always report the route (ignore impl.describe), or drop the
     route fallback for unregistered stages. */
  it("describeStageAssignments uses each implementation's describe, else the route", () => {
    registerStageImplementation("spine", "local", sentinel("chat-spine"));
    const assignments = describeStageAssignments({ source: { FORAY_LLM_BASE_URL: BASE_URL } });
    expect(assignments.spine).toEqual({ impl: "local", model: "chat-spine-model", machine: "spark-box" });
    expect(assignments.deepen).toEqual({ impl: "local", model: "local-worker", machine: "second" });
    expect(assignments.research).toEqual({ impl: "none", model: "none" });
    expect(assignments["spine-alt"]).toBeUndefined();
  });

  /* Mutation: make the swap's undo a no-op and the sentinel survives. */
  it("the test seam swaps one registration and restores it", () => {
    registerStageImplementation("spine", "anthropic", sentinel("real"));
    const restore = __swapStageImplementationForTests("spine", "anthropic", sentinel("sentinel"));
    expect(instantiateStage("spine", { source: { ANTHROPIC_API_KEY: "k" } })).toEqual({ name: "sentinel" });
    restore();
    expect(instantiateStage("spine", { source: { ANTHROPIC_API_KEY: "k" } })).toEqual({ name: "real" });
  });
});
