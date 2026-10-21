import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { z } from "zod";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import {
  CheckpointSession,
  checkpointFingerprint,
  checkpointForkStamp,
  checkpointRunVariant,
  forkSeedRefusal,
  CHECKPOINT_VERSION,
  CheckpointForkStampSchema,
  retrievalModeVariant,
  routingVariant,
  specificsCheckVariant,
  seamPolicyVariant,
  claimOnlyOpeningVariant,
  pauseSnapVariant,
  researchShortlistVariant,
  spineTierSizingVariant,
  tierRuntimeCapVariant,
  voiceGateVariant,
  writerExemplarsVariant,
  type CheckpointRunFlags,
  type CheckpointStore
} from "../src/generation/checkpoint";
import { RESEARCH_SHORTLIST_ENV } from "../src/generation/generationFlags";
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
      /* GV-68: the legacy mode needs both opt-ins. */
      { FORAY_GENERATION_MODE: "anthropic-legacy", FORAY_ALLOW_ANTHROPIC_LEGACY: "1" },
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
    const legacy = resolveRouting({ ANTHROPIC_API_KEY: "sk-ant-synthetic", FORAY_GENERATION_MODE: "anthropic-legacy", FORAY_ALLOW_ANTHROPIC_LEGACY: "1" });
    const legacyLocalSpine = resolveRouting({
      ANTHROPIC_API_KEY: "sk-ant-synthetic",
      FORAY_LLM_BASE_URL: LLM,
      FORAY_GENERATION_MODE: "anthropic-legacy",
      FORAY_ALLOW_ANTHROPIC_LEGACY: "1",
      FORAY_STAGE_SPINE: "local"
    });
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
    /* The fast path: GV-15's flag variant, then the order, then (GV-127) the
       tier cap the umbrella turns on, then (local) the routing. */
    const local = resolveRouting({ FORAY_LLM_BASE_URL: LLM });
    expect(checkpointRunVariant(FAST_PATH_PIPELINE_FLAGS)).toBe(`${checkpointVariant(FAST_PATH_PIPELINE_FLAGS)}|narration=sequential|tierCap=on`);
    expect(checkpointRunVariant(FAST_PATH_PIPELINE_FLAGS, local)).toBe(
      `${checkpointVariant(FAST_PATH_PIPELINE_FLAGS)}|narration=sequential|tierCap=on|${routingVariant(local)}`
    );
    expect(checkpointRunVariant(CLASSIC_PIPELINE_FLAGS, local)).toBe(routingVariant(local));
  });

  /* GV-125 (#1413 item 17). Kills: leaving the retrieval mode out of the
     variant (`retrievalModeVariant` returning undefined: a hybrid run would
     resume stages a bm25 run banked), or joining bm25 too (every banked run
     with a retrieval server would stop resuming). Ran both: red. */
  it("joins FORAY_RETRIEVAL_MODE=hybrid, and leaves bm25 and no server out (byte-identical)", () => {
    const local = resolveRouting({ FORAY_LLM_BASE_URL: LLM });
    for (const mode of [undefined, "bm25" as const]) {
      expect(retrievalModeVariant(mode)).toBeUndefined();
      expect(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, retrievalMode: mode })).toBeUndefined();
      expect(fp(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, retrievalMode: mode }))).toBe(TODAY);
      expect(checkpointRunVariant({ ...FAST_PATH_PIPELINE_FLAGS, retrievalMode: mode }, local)).toBe(checkpointRunVariant(FAST_PATH_PIPELINE_FLAGS, local));
    }
    const hybrid = { ...CLASSIC_PIPELINE_FLAGS, retrievalMode: "hybrid" as const };
    expect(checkpointRunVariant(hybrid)).toBe("retrieval=hybrid");
    expect(fp(checkpointRunVariant(hybrid))).not.toBe(TODAY);
    /* After the flags and the narration order, before the spine best-of and the routing. */
    expect(checkpointRunVariant({ ...FAST_PATH_PIPELINE_FLAGS, retrievalMode: "hybrid", spineBestOf: 2 }, local)).toBe(
      `${checkpointVariant(FAST_PATH_PIPELINE_FLAGS)}|narration=sequential|retrieval=hybrid|spine=best-of-2|tierCap=on|${routingVariant(local)}`
    );
  });

  /* GV-125. Kills: a fork stamp whose `flags` leaves the retrieval mode out
     (arm B under hybrid would fork arm A's bm25-built research map). */
  it("a seed built under another retrieval mode is not forked; under bm25 the stamp is unchanged", () => {
    const routing = resolveRouting({});
    const stamp = (retrievalMode?: "bm25" | "hybrid") =>
      checkpointForkStamp({ prompt: input.prompt, duration: input.duration, topic: input.topic, flags: { ...CLASSIC_PIPELINE_FLAGS, retrievalMode }, routing });
    expect(stamp("bm25")).toEqual(stamp());
    expect(stamp("hybrid").flags).toBe("retrieval=hybrid");
    const seed = { version: CHECKPOINT_VERSION, fingerprint: "seed-print", fork: stamp() };
    expect(forkSeedRefusal(seed, { fingerprint: "run-print", stamp: stamp("hybrid") }, "narrate")).toMatch(/other pipeline flags/);
    expect(forkSeedRefusal(seed, { fingerprint: "run-print", stamp: stamp("bm25") }, "narrate")).toBeNull();
  });

  /* GV-126 (#1413 items 21, 24). Kills: leaving either part out of the
     variant (`spineTierSizingVariant` or `writerExemplarsVariant` returning
     undefined: a run with the flag on would resume a spine, or narration,
     banked with it off), or joining either when off (every banked run would
     stop resuming). Ran each: red. */
  it("joins spine=tier-sized and exemplars=on only when on; off or absent, the fingerprint is today's", () => {
    const local = resolveRouting({ FORAY_LLM_BASE_URL: LLM });
    for (const off of [{}, { spineTierSizing: false, writerExemplars: "off" as const }, { spineTierSizing: undefined, writerExemplars: undefined }]) {
      expect(spineTierSizingVariant(off)).toBeUndefined();
      expect(writerExemplarsVariant(off)).toBeUndefined();
      expect(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, ...off })).toBeUndefined();
      expect(fp(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, ...off }))).toBe(TODAY);
      expect(checkpointRunVariant({ ...FAST_PATH_PIPELINE_FLAGS, ...off }, local)).toBe(checkpointRunVariant(FAST_PATH_PIPELINE_FLAGS, local));
    }
    const tier = { ...CLASSIC_PIPELINE_FLAGS, spineTierSizing: true };
    const exemplars = { ...CLASSIC_PIPELINE_FLAGS, writerExemplars: "on" as const };
    expect(checkpointRunVariant(tier)).toBe("spine=tier-sized");
    expect(checkpointRunVariant(exemplars)).toBe("exemplars=on");
    const prints = new Set([TODAY, fp(checkpointRunVariant(tier)), fp(checkpointRunVariant(exemplars)), fp(checkpointRunVariant({ ...tier, writerExemplars: "on" }))]);
    expect(prints.size).toBe(4);
    /* After the spine best-of, before the routing. */
    expect(checkpointRunVariant({ ...FAST_PATH_PIPELINE_FLAGS, retrievalMode: "hybrid", spineBestOf: 2, spineTierSizing: true, writerExemplars: "on" }, local)).toBe(
      `${checkpointVariant(FAST_PATH_PIPELINE_FLAGS)}|narration=sequential|retrieval=hybrid|spine=best-of-2|spine=tier-sized|exemplars=on|tierCap=on|${routingVariant(local)}`
    );
  });

  /* GV-126. Kills: putting either lever in the stamp's `flags` (E3's arm B,
     exemplars on, could no longer fork arm A from narrate; ran it: red), or
     dropping its lever comparison (a seed rerun from stitch, or from deepen
     under another spine sizing, would keep work built under the other
     setting; ran it: red), or writing the fields when off (an off stamp
     would differ from a pre-GV-126 one). */
  it("the fork stamp carries both only when on, and compares them like a route to the stage they feed", () => {
    const routing = resolveRouting({});
    const stamp = (extra: { spineTierSizing?: boolean; writerExemplars?: "off" | "on" } = {}) =>
      checkpointForkStamp({ prompt: input.prompt, duration: input.duration, topic: input.topic, flags: { ...CLASSIC_PIPELINE_FLAGS, ...extra }, routing });
    const before = stamp();
    expect(stamp({ spineTierSizing: false, writerExemplars: "off" })).toEqual(before);
    expect(Object.keys(before)).not.toContain("spineTierSizing");
    expect(Object.keys(before)).not.toContain("exemplars");
    const armA = { version: CHECKPOINT_VERSION, fingerprint: "arm-a", fork: before };
    /* E3: arm B with exemplars on forks arm A from narrate (and earlier), not from stitch. */
    const armB = { fingerprint: "arm-b", stamp: stamp({ writerExemplars: "on" }) };
    expect(armB.stamp.flags).toBe(before.flags);
    expect(armB.stamp.exemplars).toBe("on");
    expect(forkSeedRefusal(armA, armB, "narrate")).toBeNull();
    expect(forkSeedRefusal(armA, armB, "spine")).toBeNull();
    expect(forkSeedRefusal(armA, armB, "stitch")).toMatch(/FORAY_WRITER_EXEMPLARS differs \(off; this run on\) and feeds narrate/);
    /* And the reverse: a seed built with exemplars on, run with them off. */
    expect(forkSeedRefusal({ ...armA, fingerprint: "arm-b", fork: armB.stamp }, { fingerprint: "arm-a", stamp: before }, "stitch")).toMatch(/FORAY_WRITER_EXEMPLARS differs \(on; this run off\)/);
    /* Tier sizing feeds the spine. */
    const tiered = { fingerprint: "tiered", stamp: stamp({ spineTierSizing: true }) };
    expect(tiered.stamp.flags).toBe(before.flags);
    expect(forkSeedRefusal(armA, tiered, "spine")).toBeNull();
    expect(forkSeedRefusal(armA, tiered, "deepen")).toMatch(/FORAY_SPINE_TIER_SIZING differs \(off; this run on\) and feeds spine/);
    /* A stamp round-trips through its schema (what a kept checkpoint holds). */
    expect(CheckpointForkStampSchema.parse(JSON.parse(JSON.stringify(stamp({ spineTierSizing: true, writerExemplars: "on" }))))).toEqual(
      stamp({ spineTierSizing: true, writerExemplars: "on" })
    );
  });

  /* GV-127 (#1413 items 36, 40). MUTATIONS THAT KILL THIS: drop any one of
     tierRuntimeCapVariant, voiceGateVariant or specificsCheckVariant from
     checkpointRunVariant (a cap-on or enforcing run would resume a spine,
     sourcing or narration banked without it); join a gate in `report` mode
     too (`voiceGate !== "off"`: every default run, report being the
     default, would stop resuming); or join the cap when off. Ran each: red. */
  it("joins tierCap=on only when the cap is on and voice=enforce / specifics=enforce only when enforcing; otherwise the fingerprint is today's", () => {
    const local = resolveRouting({ FORAY_LLM_BASE_URL: LLM });
    const dark = [
      {},
      { tierRuntimeCap: false, voiceGate: "report" as const, specifics: "report" as const },
      { tierRuntimeCap: false, voiceGate: "off" as const, specifics: "off" as const },
      { tierRuntimeCap: undefined, voiceGate: undefined, specifics: undefined }
    ];
    for (const off of dark) {
      const label = JSON.stringify(off);
      expect(tierRuntimeCapVariant(off), label).toBeUndefined();
      expect(voiceGateVariant(off), label).toBeUndefined();
      expect(specificsCheckVariant(off), label).toBeUndefined();
      expect(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, ...off }), label).toBeUndefined();
      expect(fp(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, ...off })), label).toBe(TODAY);
      expect(fp(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, ...off }, resolveRouting({}))), label).toBe(TODAY);
    }
    const cap = { ...CLASSIC_PIPELINE_FLAGS, tierRuntimeCap: true };
    const voice = { ...CLASSIC_PIPELINE_FLAGS, voiceGate: "enforce" as const };
    const specifics = { ...CLASSIC_PIPELINE_FLAGS, specifics: "enforce" as const };
    expect(checkpointRunVariant(cap)).toBe("tierCap=on");
    expect(checkpointRunVariant(voice)).toBe("voice=enforce");
    expect(checkpointRunVariant(specifics)).toBe("specifics=enforce");
    const prints = new Set([
      TODAY,
      fp(checkpointRunVariant(cap)),
      fp(checkpointRunVariant(voice)),
      fp(checkpointRunVariant(specifics)),
      fp(checkpointRunVariant({ ...voice, specifics: "enforce" }))
    ]);
    expect(prints.size).toBe(5);
    /* The fast path turns the cap on, and its other parts do not separate a
       cap-off fast path from it: the cap's own part does. */
    expect(FAST_PATH_PIPELINE_FLAGS.tierRuntimeCap).toBe(true);
    const capOffFast = checkpointRunVariant({ ...FAST_PATH_PIPELINE_FLAGS, tierRuntimeCap: false }, local);
    expect(capOffFast).toBe(`${checkpointVariant(FAST_PATH_PIPELINE_FLAGS)}|narration=sequential|${routingVariant(local)}`);
    expect(checkpointRunVariant(FAST_PATH_PIPELINE_FLAGS, local)).not.toBe(capOffFast);
    /* After the writer exemplars, before the routing, in a fixed order. */
    expect(checkpointRunVariant({ ...FAST_PATH_PIPELINE_FLAGS, writerExemplars: "on", voiceGate: "enforce", specifics: "enforce" }, local)).toBe(
      `${checkpointVariant(FAST_PATH_PIPELINE_FLAGS)}|narration=sequential|exemplars=on|tierCap=on|voice=enforce|specifics=enforce|${routingVariant(local)}`
    );
  });

  /* GV-127. MUTATIONS THAT KILL THIS: put the cap or an enforcing gate in the
     stamp's `flags` (an arm with the cap on could no longer fork a cap-off
     arm from spine); drop a lever comparison (a seed rerun from deepen under
     another cap, or from stitch under another gate mode, would keep work
     built under the other setting); or write the fields when off or in
     report mode (an off stamp would differ from a pre-GV-127 one). Ran
     each: red. */
  it("the fork stamp carries the cap and the enforcing gates only when on, and compares them like a route to the stage they feed", () => {
    const routing = resolveRouting({});
    type Mode = "off" | "report" | "enforce";
    const stamp = (extra: { tierRuntimeCap?: boolean; voiceGate?: Mode; specifics?: Mode } = {}) =>
      checkpointForkStamp({ prompt: input.prompt, duration: input.duration, topic: input.topic, flags: { ...CLASSIC_PIPELINE_FLAGS, ...extra }, routing });
    const before = stamp();
    expect(stamp({ tierRuntimeCap: false, voiceGate: "report", specifics: "report" })).toEqual(before);
    expect(stamp({ voiceGate: "off", specifics: "off" })).toEqual(before);
    expect(Object.keys(before).sort()).toEqual(["flags", "request", "routes", "selfCritique", "spineBestOf"]);
    const armA = { version: CHECKPOINT_VERSION, fingerprint: "arm-a", fork: before };
    /* The tier cap feeds the spine (and sourcing after it). */
    const capped = { fingerprint: "capped", stamp: stamp({ tierRuntimeCap: true }) };
    expect(capped.stamp.flags).toBe(before.flags);
    expect(capped.stamp.tierCap).toBe("on");
    expect(forkSeedRefusal(armA, capped, "spine")).toBeNull();
    expect(forkSeedRefusal(armA, capped, "deepen")).toMatch(/FORAY_TIER_RUNTIME_CAP differs \(off; this run on\) and feeds spine/);
    expect(forkSeedRefusal(armA, capped, "source")).toMatch(/FORAY_TIER_RUNTIME_CAP differs/);
    expect(forkSeedRefusal({ ...armA, fingerprint: "capped", fork: capped.stamp }, { fingerprint: "arm-a", stamp: before }, "narrate")).toMatch(
      /FORAY_TIER_RUNTIME_CAP differs \(on; this run off\)/
    );
    /* Each enforcing gate feeds narration. */
    for (const [lever, extra] of [
      ["FORAY_VOICE_GATE", { voiceGate: "enforce" }],
      ["FORAY_SPECIFICS_CHECK", { specifics: "enforce" }]
    ] as const) {
      const enforcing = { fingerprint: "enforcing", stamp: stamp(extra) };
      expect(enforcing.stamp.flags).toBe(before.flags);
      expect(forkSeedRefusal(armA, enforcing, "narrate")).toBeNull();
      expect(forkSeedRefusal(armA, enforcing, "source")).toBeNull();
      expect(forkSeedRefusal(armA, enforcing, "stitch")).toBe(
        `${lever} differs (not enforce; this run enforce) and feeds narrate, before --rerun-from stitch`
      );
      expect(forkSeedRefusal({ ...armA, fingerprint: "enforcing", fork: enforcing.stamp }, { fingerprint: "arm-a", stamp: before }, "stitch")).toBe(
        `${lever} differs (enforce; this run not enforce) and feeds narrate, before --rerun-from stitch`
      );
    }
    /* A stamp round-trips through its schema (what a kept checkpoint holds). */
    const all = stamp({ tierRuntimeCap: true, voiceGate: "enforce", specifics: "enforce" });
    expect(all).toMatchObject({ tierCap: "on", voice: "enforce", specifics: "enforce" });
    expect(CheckpointForkStampSchema.parse(JSON.parse(JSON.stringify(all)))).toEqual(all);
  });

  /* GV-108 (orchestrator, #1476 review; decision 20). MUTATIONS THAT KILL
     THIS: drop seamPolicyVariant from checkpointRunVariant (a cut run would
     resume narration banked under keep, bringing back unverified pages and
     HANDOFF_SCRIPT, and the reverse); join it under keep (every default run
     would stop resuming); or drop the stamp's lever row. */
  it("joins seamPolicy=cut only under cut, stamps it only under cut, and refuses a fork that keeps narration across the policy", () => {
    for (const off of [{}, { unverifiedSeamPolicy: "keep" as const }, { unverifiedSeamPolicy: undefined }]) {
      expect(seamPolicyVariant(off)).toBeUndefined();
      expect(fp(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, ...off }))).toBe(TODAY);
    }
    const cut = { ...CLASSIC_PIPELINE_FLAGS, unverifiedSeamPolicy: "cut" as const };
    expect(checkpointRunVariant(cut)).toBe("seamPolicy=cut");
    expect(fp(checkpointRunVariant(cut))).not.toBe(TODAY);
    expect(checkpointRunVariant({ ...cut, voiceGate: "enforce", specifics: "enforce" })).toBe("voice=enforce|specifics=enforce|seamPolicy=cut");

    const routing = resolveRouting({});
    const stamp = (policy?: "keep" | "cut") =>
      checkpointForkStamp({ prompt: input.prompt, duration: input.duration, topic: input.topic, flags: { ...CLASSIC_PIPELINE_FLAGS, unverifiedSeamPolicy: policy }, routing });
    const keepStamp = stamp("keep");
    expect(keepStamp).toEqual(stamp());
    expect("seamPolicy" in keepStamp).toBe(false);
    const cutStamp = stamp("cut");
    expect(cutStamp.seamPolicy).toBe("cut");
    expect(cutStamp.flags).toBe(keepStamp.flags);
    const keepArm = { version: CHECKPOINT_VERSION, fingerprint: "keep", fork: keepStamp };
    expect(forkSeedRefusal(keepArm, { fingerprint: "cut", stamp: cutStamp }, "narrate")).toBeNull();
    expect(forkSeedRefusal(keepArm, { fingerprint: "cut", stamp: cutStamp }, "stitch")).toBe(
      "FORAY_UNVERIFIED_SEAM_POLICY differs (keep; this run cut) and feeds narrate, before --rerun-from stitch"
    );
    expect(forkSeedRefusal({ ...keepArm, fingerprint: "cut", fork: cutStamp }, { fingerprint: "keep", stamp: keepStamp }, "stitch")).toBe(
      "FORAY_UNVERIFIED_SEAM_POLICY differs (cut; this run keep) and feeds narrate, before --rerun-from stitch"
    );
    expect(CheckpointForkStampSchema.parse(JSON.parse(JSON.stringify(cutStamp)))).toEqual(cutStamp);
  });

  /* GV-109 (W5-13; MQ-06; orchestrator note, the GV-108 pattern). MUTATIONS
     THAT KILL THIS: drop claimOnlyOpeningVariant from checkpointRunVariant (a
     refuse run would resume tape sourced under allow, claim-only openings
     and all, and the reverse); join it under allow (every default run's
     fingerprint moves and no banked run resumes); drop the stamp field or
     the lever row (a seed rerun from narrate would keep the other mode's
     sourcing). Ran each: red. */
  it("joins claimOnlyOpening=refuse only under refuse, stamps it only under refuse, and refuses a fork that keeps sourcing across the mode", () => {
    for (const off of [{}, { claimOnlyOpening: "allow" as const }, { claimOnlyOpening: undefined }]) {
      expect(claimOnlyOpeningVariant(off)).toBeUndefined();
      expect(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, ...off })).toBeUndefined();
      expect(fp(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, ...off }))).toBe(TODAY);
    }
    const refuse = { ...CLASSIC_PIPELINE_FLAGS, claimOnlyOpening: "refuse" as const };
    expect(checkpointRunVariant(refuse)).toBe("claimOnlyOpening=refuse");
    expect(fp(checkpointRunVariant(refuse))).not.toBe(TODAY);
    expect(checkpointRunVariant({ ...refuse, unverifiedSeamPolicy: "cut" })).toBe("seamPolicy=cut|claimOnlyOpening=refuse");

    const routing = resolveRouting({});
    const stamp = (mode?: "allow" | "refuse") =>
      checkpointForkStamp({ prompt: input.prompt, duration: input.duration, topic: input.topic, flags: { ...CLASSIC_PIPELINE_FLAGS, claimOnlyOpening: mode }, routing });
    const allowStamp = stamp("allow");
    expect(allowStamp).toEqual(stamp());
    expect("claimOnlyOpening" in allowStamp).toBe(false);
    const refuseStamp = stamp("refuse");
    expect(refuseStamp.claimOnlyOpening).toBe("refuse");
    expect(refuseStamp.flags).toBe(allowStamp.flags);
    const allowArm = { version: CHECKPOINT_VERSION, fingerprint: "allow", fork: allowStamp };
    expect(forkSeedRefusal(allowArm, { fingerprint: "refuse", stamp: refuseStamp }, "source")).toBeNull();
    expect(forkSeedRefusal(allowArm, { fingerprint: "refuse", stamp: refuseStamp }, "narrate")).toBe(
      "FORAY_CLAIM_ONLY_OPENING differs (allow; this run refuse) and feeds source, before --rerun-from narrate"
    );
    expect(forkSeedRefusal({ ...allowArm, fingerprint: "refuse", fork: refuseStamp }, { fingerprint: "allow", stamp: allowStamp }, "narrate")).toBe(
      "FORAY_CLAIM_ONLY_OPENING differs (refuse; this run allow) and feeds source, before --rerun-from narrate"
    );
    expect(CheckpointForkStampSchema.parse(JSON.parse(JSON.stringify(refuseStamp)))).toEqual(refuseStamp);
  });

  /* GV-111 (W5-14b; orchestrator note, the GV-108/GV-109 pattern). MUTATIONS
     THAT KILL THIS: drop pauseSnapVariant from checkpointRunVariant (an on
     run would resume cue-edge cuts banked under off, and the reverse); join
     it under off (every default run's fingerprint moves and no banked run
     resumes); drop the stamp field or the lever row (a seed rerun from
     narrate would keep the other mode's cuts). Ran each: red. */
  it("joins pauseSnap=on only when on, stamps it only when on, and refuses a fork that keeps sourcing across the mode", () => {
    for (const off of [{}, { pauseSnap: "off" as const }, { pauseSnap: undefined }]) {
      expect(pauseSnapVariant(off)).toBeUndefined();
      expect(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, ...off })).toBeUndefined();
      expect(fp(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, ...off }))).toBe(TODAY);
    }
    const on = { ...CLASSIC_PIPELINE_FLAGS, pauseSnap: "on" as const };
    expect(checkpointRunVariant(on)).toBe("pauseSnap=on");
    expect(fp(checkpointRunVariant(on))).not.toBe(TODAY);
    expect(checkpointRunVariant({ ...on, claimOnlyOpening: "refuse" })).toBe("claimOnlyOpening=refuse|pauseSnap=on");

    const routing = resolveRouting({});
    const stamp = (mode?: "off" | "on") =>
      checkpointForkStamp({ prompt: input.prompt, duration: input.duration, topic: input.topic, flags: { ...CLASSIC_PIPELINE_FLAGS, pauseSnap: mode }, routing });
    const offStamp = stamp("off");
    expect(offStamp).toEqual(stamp());
    expect("pauseSnap" in offStamp).toBe(false);
    const onStamp = stamp("on");
    expect(onStamp.pauseSnap).toBe("on");
    expect(onStamp.flags).toBe(offStamp.flags);
    const offArm = { version: CHECKPOINT_VERSION, fingerprint: "off", fork: offStamp };
    expect(forkSeedRefusal(offArm, { fingerprint: "on", stamp: onStamp }, "source")).toBeNull();
    expect(forkSeedRefusal(offArm, { fingerprint: "on", stamp: onStamp }, "narrate")).toBe(
      "FORAY_PAUSE_SNAP differs (off; this run on) and feeds source, before --rerun-from narrate"
    );
    expect(forkSeedRefusal({ ...offArm, fingerprint: "on", fork: onStamp }, { fingerprint: "off", stamp: offStamp }, "clip-scores")).toBe(
      "FORAY_PAUSE_SNAP differs (on; this run off) and feeds source, before --rerun-from clip-scores"
    );
    expect(CheckpointForkStampSchema.parse(JSON.parse(JSON.stringify(onStamp)))).toEqual(onStamp);
  });

  /* GV-112 (W3-25; orchestrator note: the shortlist flag lives in
     generationFlags, so it joins checkpointRunVariant through flagParts, and
     the fork stamp's flags with it). MUTATIONS THAT KILL THIS, each ran red:
     drop researchShortlistVariant from flagParts (an on run would resume a
     research map banked off); drop the `retrievalMode !== undefined` guard
     in its fallback (a run with no server would move its fingerprint); drop
     the environment fallback (`flags.researchShortlist ?? false`: the
     driver's store, which passes only the mode, would hash another variant
     than the pipeline's session). */
  it("joins research=shortlist only with the flag on and a retrieval server; the driver's fallback and the pipeline's explicit value agree; off is today's", () => {
    const ENV = { [RESEARCH_SHORTLIST_ENV]: "1" };
    for (const off of [{}, { researchShortlist: false }, { researchShortlist: undefined }, { retrievalMode: "bm25" as const, researchShortlist: false }]) {
      expect(researchShortlistVariant(off, ENV)).toBeUndefined();
    }
    expect(researchShortlistVariant({ retrievalMode: "bm25" }, {})).toBeUndefined();
    expect(researchShortlistVariant({ retrievalMode: "bm25" }, { [RESEARCH_SHORTLIST_ENV]: "0" })).toBeUndefined();
    expect(researchShortlistVariant({ retrievalMode: "bm25" }, ENV)).toBe("research=shortlist");
    expect(researchShortlistVariant({ researchShortlist: true }, {})).toBe("research=shortlist");

    const prior = process.env[RESEARCH_SHORTLIST_ENV];
    const routing = resolveRouting({});
    const stamp = (flags: Partial<CheckpointRunFlags>) =>
      checkpointForkStamp({ prompt: input.prompt, duration: input.duration, topic: input.topic, flags: { ...CLASSIC_PIPELINE_FLAGS, ...flags }, routing });
    try {
      delete process.env[RESEARCH_SHORTLIST_ENV];
      expect(checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, retrievalMode: "bm25" })).toBeUndefined();
      const offStamp = stamp({ retrievalMode: "bm25" });
      expect(offStamp).toEqual(stamp({}));

      process.env[RESEARCH_SHORTLIST_ENV] = "1";
      /* No server: the flag is inert and the fingerprint is today's. */
      expect(checkpointRunVariant(CLASSIC_PIPELINE_FLAGS)).toBeUndefined();
      expect(fp(checkpointRunVariant(CLASSIC_PIPELINE_FLAGS))).toBe(TODAY);
      /* The driver passes the mode only; the pipeline passes the value. */
      const driver = checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, retrievalMode: "bm25" });
      const pipeline = checkpointRunVariant({ ...CLASSIC_PIPELINE_FLAGS, retrievalMode: "bm25", researchShortlist: true });
      expect(driver).toBe("research=shortlist");
      expect(pipeline).toBe(driver);
      expect(fp(driver)).not.toBe(TODAY);
      /* After the retrieval mode, before the spine best-of and the routing. */
      const local = resolveRouting({ FORAY_LLM_BASE_URL: LLM });
      expect(checkpointRunVariant({ ...FAST_PATH_PIPELINE_FLAGS, retrievalMode: "hybrid", spineBestOf: 2 }, local)).toBe(
        `${checkpointVariant(FAST_PATH_PIPELINE_FLAGS)}|narration=sequential|retrieval=hybrid|research=shortlist|spine=best-of-2|tierCap=on|${routingVariant(local)}`
      );
      /* The fork stamp's flags carry it: a seed built without the shortlist
         is not forked into a shortlist run. */
      const onStamp = stamp({ retrievalMode: "bm25" });
      expect(onStamp.flags).toBe("research=shortlist");
      const seed = { version: CHECKPOINT_VERSION, fingerprint: "seed-print", fork: offStamp };
      expect(forkSeedRefusal(seed, { fingerprint: "run-print", stamp: onStamp }, "narrate")).toMatch(/other pipeline flags/);
    } finally {
      if (prior === undefined) delete process.env[RESEARCH_SHORTLIST_ENV];
      else process.env[RESEARCH_SHORTLIST_ENV] = prior;
    }
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

