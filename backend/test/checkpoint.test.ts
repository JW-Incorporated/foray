import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import { CheckpointSession, checkpointFingerprint, checkpointRunVariant, routingVariant, type CheckpointStore } from "../src/generation/checkpoint";
import { CLASSIC_PIPELINE_FLAGS, FAST_PATH_PIPELINE_FLAGS, checkpointVariant } from "../src/generation/pipelineFlags";
import { resolveRouting } from "../src/config/stageRouting";
import { FileCheckpointStore } from "../src/cli/checkpointStore";

/**
 * F-17/F-18. Run 1 attempt 4 ran 2 h 35 m, made 103 model calls, finished 22 of
 * 31 beats, and then threw away every one of them because beat 23's narration
 * page was rejected a third time — the batch driver's only resume key is the
 * candidate FILE, which a failed run never writes.
 *
 * `runPipelineCheckpoint.test.ts` drives the whole pipeline through this; these
 * are the store's own rules.
 */

const Payload = z.object({ n: z.number() });
const parsePayload = (raw: unknown) => Payload.parse(raw);
const FP = checkpointFingerprint({ prompt: "a prompt", duration: "medium" });

describe("CheckpointSession", () => {
  it("runs a stage and persists its output the first time", async () => {
    const store = new FakeCheckpointStore(FP);
    const session = await CheckpointSession.open(store, "k", FP);
    let calls = 0;
    const { value, resumed } = await session.stage("spine", parsePayload, async () => {
      calls++;
      return { n: 1 };
    });
    expect(value).toEqual({ n: 1 });
    expect(resumed).toBe(false);
    expect(calls).toBe(1);
    expect(store.saves).toEqual([{ key: "k", stage: "spine" }]);
  });

  it("skips a stage whose output is already on disk", async () => {
    const store = new FakeCheckpointStore(FP);
    store.save("k", "spine", { n: 7 });
    const session = await CheckpointSession.open(store, "k", FP);
    let calls = 0;
    const { value, resumed } = await session.stage("spine", parsePayload, async () => {
      calls++;
      return { n: 99 };
    });
    expect(value).toEqual({ n: 7 });
    expect(resumed).toBe(true);
    expect(calls).toBe(0);
    expect(session.resumed()).toEqual(["spine"]);
  });

  it("re-runs a stage whose stored output no longer parses", async () => {
    /* A checkpoint file is JSON a person can edit and a killed process can
       truncate. A wrong resume is more expensive than a repeated one. */
    const store = new FakeCheckpointStore(FP);
    store.save("k", "spine", { n: "not a number" });
    const session = await CheckpointSession.open(store, "k", FP);
    let calls = 0;
    const { value, resumed } = await session.stage("spine", parsePayload, async () => {
      calls++;
      return { n: 3 };
    });
    expect(value).toEqual({ n: 3 });
    expect(resumed).toBe(false);
    expect(calls).toBe(1);
  });

  it("discards a checkpoint written for a different request", async () => {
    const store = new FakeCheckpointStore(FP);
    store.save("k", "spine", { n: 7 });
    const other = checkpointFingerprint({ prompt: "a prompt", duration: "short" });
    const session = await CheckpointSession.open(store, "k", other);
    let calls = 0;
    await session.stage("spine", parsePayload, async () => {
      calls++;
      return { n: 1 };
    });
    /* Resuming a spine built for a different duration tier would be a WRONG
       Foray rather than a slow one. */
    expect(calls).toBe(1);
  });

  it("is inert with no store and with no key", async () => {
    const noStore = await CheckpointSession.open(undefined, "k", FP);
    const noKey = await CheckpointSession.open(new FakeCheckpointStore(FP), undefined, FP);
    for (const session of [noStore, noKey]) {
      let calls = 0;
      const { value, resumed } = await session.stage("spine", parsePayload, async () => {
        calls++;
        return { n: 1 };
      });
      expect({ value, resumed, calls }).toEqual({ value: { n: 1 }, resumed: false, calls: 1 });
      expect(session.resumed()).toEqual([]);
    }
  });

  it("never fails a stage because the store could not be read or written", async () => {
    /* The cost of a lost checkpoint is one repeated stage. The cost of
       throwing here is the whole Foray, which is the bug F-17 is about. */
    const broken: CheckpointStore = {
      load() {
        throw new Error("disk gone");
      },
      save() {
        throw new Error("disk still gone");
      }
    };
    const session = await CheckpointSession.open(broken, "k", FP);
    const { value } = await session.stage("spine", parsePayload, async () => ({ n: 5 }));
    expect(value).toEqual({ n: 5 });
  });

  it("resumeSync/save give a parallel stage per-unit resume", async () => {
    const store = new FakeCheckpointStore(FP);
    store.save("k", "deepen:1", { n: 11 });
    const session = await CheckpointSession.open(store, "k", FP);

    expect(session.resumeSync("deepen:0", parsePayload)).toBeUndefined();
    expect(session.resumeSync("deepen:1", parsePayload)).toEqual({ n: 11 });
    await session.save("deepen:0", { n: 10 });
    expect(session.resumeSync("deepen:0", parsePayload)).toEqual({ n: 10 });
    expect(session.resumed()).toContain("deepen:1");
  });
});

describe("checkpointFingerprint", () => {
  it("is stable for the same request and different for a changed one", () => {
    const base = { prompt: "p", duration: "medium" };
    expect(checkpointFingerprint(base)).toBe(checkpointFingerprint({ ...base }));
    expect(checkpointFingerprint(base)).not.toBe(checkpointFingerprint({ ...base, duration: "long" }));
    expect(checkpointFingerprint(base)).not.toBe(checkpointFingerprint({ ...base, prompt: "q" }));
    expect(checkpointFingerprint(base)).not.toBe(checkpointFingerprint({ ...base, topic: "food/grilling-bbq" }));
  });
});

/* GV-55 (decision 20, R2-21): the routing joins the ONE checkpoint variant,
   only in local mode or with a stage overridden, and the narration order
   joins it when sequential (orchestrator's follow-up to the wave 5/6
   reviews). Every routing table here is resolved from an injected source:
   nothing reads process.env and nothing opens a connection. */
describe("checkpointRunVariant (GV-55)", () => {
  const input = { prompt: "the history of grilling", duration: "medium", topic: "food/grilling-bbq" };
  /** The pre-GV-15 hash of `input` (pinned in pipelineFlags.test.ts too). */
  const TODAY = "1f8c63c986bd";
  const LLM = "http://user:secret@litellm.test:4000/v1?token=abc";
  const fp = (variant: string | undefined): string => checkpointFingerprint({ ...input, variant });

  /* Kills: joining the routing in every mode (`routingVariant` without its
     mode/overridden guard): every stub and legacy banked run would stop
     resuming. */
  it("is unchanged for stub and legacy inputs: the fingerprint is today's value", () => {
    const sources: NodeJS.ProcessEnv[] = [
      {},
      { ANTHROPIC_API_KEY: "sk-ant-synthetic" },
      { FORAY_GENERATION_MODE: "stub" },
      { FORAY_GENERATION_MODE: "anthropic-legacy" },
      { JEV_API_KEY: "jev-synthetic" },
      { ANTHROPIC_API_KEY: "sk-ant-synthetic", JEV_API_KEY: "jev-synthetic" }
    ];
    for (const source of sources) {
      const routing = resolveRouting(source);
      expect(routingVariant(routing), JSON.stringify(source)).toBeUndefined();
      expect(checkpointRunVariant(CLASSIC_PIPELINE_FLAGS, routing), JSON.stringify(source)).toBeUndefined();
      expect(fp(checkpointRunVariant(CLASSIC_PIPELINE_FLAGS, routing)), JSON.stringify(source)).toBe(TODAY);
    }
    expect(fp(checkpointRunVariant(CLASSIC_PIPELINE_FLAGS))).toBe(TODAY);
  });

  /* Kills: a routing string without the lane (spine on the second box would
     resume the Spark's banked spine), or no routing part at all. */
  it("differs between two local routings, and from the stub run", () => {
    const spark = resolveRouting({ FORAY_LLM_BASE_URL: LLM });
    const second = resolveRouting({ FORAY_LLM_BASE_URL: LLM, FORAY_STAGE_SPINE: "local:second" });
    const jevClarity = resolveRouting({ FORAY_LLM_BASE_URL: LLM, FORAY_STAGE_UNDERSTAND_CLARITY: "jev" });
    const prints = [undefined, spark, second, jevClarity].map((r) => fp(checkpointRunVariant(CLASSIC_PIPELINE_FLAGS, r)));
    expect(new Set(prints).size).toBe(4);
    expect(prints[0]).toBe(TODAY);
    /* The same table resolves to the same variant: a run resumes its own stages. */
    expect(checkpointRunVariant(CLASSIC_PIPELINE_FLAGS, resolveRouting({ FORAY_LLM_BASE_URL: LLM }))).toBe(
      checkpointRunVariant(CLASSIC_PIPELINE_FLAGS, spark)
    );
    expect(routingVariant(second)).toContain("spine=local@second/");
    expect(routingVariant(spark)).toMatch(/^routing=local:/);
  });

  /* Kills: guarding on `mode === "local"` alone (a legacy run with one stage
     routed local would resume the Claude-built stage under it). */
  it("joins the routing when a stub or legacy run overrides a stage", () => {
    const legacy = resolveRouting({ ANTHROPIC_API_KEY: "sk-ant-synthetic" });
    const legacyLocalSpine = resolveRouting({ ANTHROPIC_API_KEY: "sk-ant-synthetic", FORAY_LLM_BASE_URL: LLM, FORAY_GENERATION_MODE: "anthropic-legacy", FORAY_STAGE_SPINE: "local" });
    expect(routingVariant(legacy)).toBeUndefined();
    expect(routingVariant(legacyLocalSpine)).toContain("spine=local@spark/");
    expect(fp(checkpointRunVariant(CLASSIC_PIPELINE_FLAGS, legacyLocalSpine))).not.toBe(TODAY);
  });

  /* Kills: a routing string built from the summary's llm field or the raw
     table (the base URL may carry credentials). */
  it("never carries the base URL or its credentials", () => {
    const variant = routingVariant(resolveRouting({ FORAY_LLM_BASE_URL: LLM, FORAY_LLM_API_KEY: "sk-litellm-synthetic" }))!;
    for (const secret of ["secret", "litellm.test", "token", "sk-litellm-synthetic", "user:"]) expect(variant).not.toContain(secret);
  });

  /* Kills: leaving narrationOrder out of the variant (a sequential run would
     resume acts a parallel run narrated), or encoding it as "differs from the
     default" (a later default flip would move every banked fingerprint). */
  it("joins the narration order when sequential, and leaves today's parallel out", () => {
    const sequential = { ...CLASSIC_PIPELINE_FLAGS, narrationOrder: "sequential" as const };
    expect(checkpointRunVariant(sequential)).toBe("narration=sequential");
    expect(fp(checkpointRunVariant(sequential))).not.toBe(TODAY);
    expect(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, narrationOrder: "parallel" })).toBeUndefined();
    /* The fast path: GV-15's flag variant, then the order, then (local) the routing. */
    const local = resolveRouting({ FORAY_LLM_BASE_URL: LLM });
    expect(checkpointRunVariant(FAST_PATH_PIPELINE_FLAGS)).toBe(`${checkpointVariant(FAST_PATH_PIPELINE_FLAGS)}|narration=sequential`);
    expect(checkpointRunVariant(FAST_PATH_PIPELINE_FLAGS, local)).toBe(
      `${checkpointVariant(FAST_PATH_PIPELINE_FLAGS)}|narration=sequential|${routingVariant(local)}`
    );
    expect(checkpointRunVariant(CLASSIC_PIPELINE_FLAGS, local)).toBe(routingVariant(local));
  });
});

describe("FileCheckpointStore", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-checkpoint-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes one <basename>.checkpoint.json beside the candidate", () => {
    const store = new FileCheckpointStore(dir, FP);
    store.save("grilling-abc12345", "spine", { n: 1 });
    const file = path.join(dir, "grilling-abc12345.checkpoint.json");
    expect(fs.existsSync(file)).toBe(true);
    expect(store.filePathFor("grilling-abc12345")).toBe(file);
  });

  it("accumulates stages across saves rather than replacing the file", () => {
    const store = new FileCheckpointStore(dir, FP);
    store.save("k", "understand", { n: 1 });
    store.save("k", "spine", { n: 2 });
    store.save("k", "deepen:0", { n: 3 });
    const loaded = store.load("k")!;
    expect(Object.keys(loaded.stages).sort()).toEqual(["deepen:0", "spine", "understand"]);
  });

  it("leaves no .tmp file behind", () => {
    const store = new FileCheckpointStore(dir, FP);
    store.save("k", "spine", { n: 1 });
    expect(fs.readdirSync(dir)).toEqual(["k.checkpoint.json"]);
  });

  it("returns null for a missing file, unreadable JSON, or a foreign shape", () => {
    const store = new FileCheckpointStore(dir, FP);
    expect(store.load("nothing-here")).toBeNull();
    fs.writeFileSync(path.join(dir, "broken.checkpoint.json"), "{ not json");
    expect(store.load("broken")).toBeNull();
    fs.writeFileSync(path.join(dir, "foreign.checkpoint.json"), JSON.stringify({ hello: "world" }));
    expect(store.load("foreign")).toBeNull();
  });

  it("drops stages from a checkpoint written for a different request", () => {
    new FileCheckpointStore(dir, FP).save("k", "spine", { n: 1 });
    const other = new FileCheckpointStore(dir, checkpointFingerprint({ prompt: "different", duration: "medium" }));
    other.save("k", "understand", { n: 2 });
    expect(Object.keys(other.load("k")!.stages)).toEqual(["understand"]);
  });

  it("discards the file once the candidate exists", () => {
    const store = new FileCheckpointStore(dir, FP);
    store.save("k", "spine", { n: 1 });
    store.discard("k");
    expect(store.load("k")).toBeNull();
    expect(() => store.discard("k")).not.toThrow();
  });
});

