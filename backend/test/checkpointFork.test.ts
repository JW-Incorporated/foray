import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  benchFlagRefusal,
  candidateFilename,
  generateOneCandidate,
  main,
  parseArgs,
  DEFAULT_MAX_RESUMES,
  type CliArgs
} from "../src/cli/generateForays";
import { FileCheckpointStore } from "../src/cli/checkpointStore";
import {
  CHECKPOINT_STAGE_ORDER,
  CHECKPOINT_VERSION,
  ROUTED_STAGE_FIRST_CHECKPOINT,
  checkpointFingerprint,
  checkpointForkStamp,
  forkSeedRefusal,
  stagesAtOrAfter
} from "../src/generation/checkpoint";
import { resolvePipelineFlags } from "../src/generation/pipelineFlags";
import { GENERATION_STAGES, resolveRouting } from "../src/config/stageRouting";
import { runForayPipeline } from "../src/generation/runPipeline";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import { FileTranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";

/**
 * GV-62 (W7-03): keep and fork checkpoints, so a stage-swap arm B reruns only
 * from the changed stage. Three layers, each with the mutation that kills it
 * named beside the assertion:
 *
 *   - the pure order and cut (`stagesAtOrAfter`), and a scan of
 *     `runPipeline.ts` that fails when it banks a stage the order does not
 *     list;
 *   - the fork rule (`forkSeedRefusal`): exact fingerprint, or a stamped seed
 *     whose differing routes all feed stages the fork rebuilds;
 *   - the driver, through `generateOneCandidate` with the REAL
 *     `runForayPipeline`, counting Stub builders, an injected finalize and a
 *     tmpdir FileCheckpointStore (no model, no network).
 */

const OK_VALIDATION = { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] };
const FAKE_FINALIZE = async (input: FinalizeForayInput): Promise<FinalizeForayResult> => ({
  validation: OK_VALIDATION,
  forayRecord: { id: input.id, generated: true },
  timings: []
});

const cueProvider = new FileTranscriptCueProvider();

type Counts = { understand: number; spine: number; deepen: number; writer: number };

/** The real pipeline with Stub builders that count their calls. */
function countingPipeline(): { run: typeof runForayPipeline; counts: Counts } {
  const counts: Counts = { understand: 0, spine: 0, deepen: 0, writer: 0 };
  class CountingUnderstander extends StubPromptUnderstander {
    override async assessClarity(...a: Parameters<StubPromptUnderstander["assessClarity"]>) {
      counts.understand++;
      return super.assessClarity(...a);
    }
    override async extractIntent(...a: Parameters<StubPromptUnderstander["extractIntent"]>) {
      counts.understand++;
      return super.extractIntent(...a);
    }
  }
  class CountingSpine extends StubSpineBuilder {
    override async buildSpine(...a: Parameters<StubSpineBuilder["buildSpine"]>) {
      counts.spine++;
      return super.buildSpine(...a);
    }
  }
  class CountingDeepen extends StubDeepenActBuilder {
    override async deepenAct(...a: Parameters<StubDeepenActBuilder["deepenAct"]>) {
      counts.deepen++;
      return super.deepenAct(...a);
    }
  }
  class CountingWriter extends StubNarrationWriterBuilder {
    override async writeAct(...a: Parameters<StubNarrationWriterBuilder["writeAct"]>) {
      counts.writer++;
      return super.writeAct(...a);
    }
    override async *writeActStream(...a: Parameters<StubNarrationWriterBuilder["writeActStream"]>) {
      counts.writer++;
      yield* super.writeActStream(...a);
    }
  }
  const run: typeof runForayPipeline = (request, options, deps = {}) =>
    runForayPipeline(request, options, {
      understander: new CountingUnderstander(),
      researcher: new StubExternalResearcher(),
      spineBuilder: new CountingSpine(),
      deepenBuilder: new CountingDeepen(),
      narrationWriter: new CountingWriter(),
      narrationVerifier: new StubNarrationVerifierBuilder(),
      continuityBuilder: new StubContinuityBuilder(),
      finalize: FAKE_FINALIZE,
      ...deps
    });
  return { run, counts };
}

function baseArgs(out: string, overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompts: null,
    out,
    duration: "short",
    limit: null,
    dryRun: false,
    authorId: "founder-1",
    budgetUsd: null,
    noResume: false,
    maxResumes: DEFAULT_MAX_RESUMES,
    continueOnRefusedPartial: false,
    notify: null,
    ...overrides
  };
}

const SPEC = { prompt: "the history of grilling and barbecue", bench: true };
const keyOf = (prompt: string): string => candidateFilename(prompt).replace(/\.json$/, "");
const checkpointPath = (dir: string, prompt = SPEC.prompt): string => path.join(dir, `${keyOf(prompt)}.checkpoint.json`);
const readJson = (file: string): Record<string, unknown> & { stages: Record<string, unknown> } => JSON.parse(fs.readFileSync(file, "utf8"));

let root: string;
let armA: string;
let armB: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-gv62-"));
  armA = path.join(root, "A");
  armB = path.join(root, "B");
  fs.mkdirSync(armA);
  fs.mkdirSync(armB);
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(root, { recursive: true, force: true });
});

/** Arm A: one bench prompt run with --keep-checkpoints. */
async function runArmA(): Promise<void> {
  const { run } = countingPipeline();
  const result = await generateOneCandidate(SPEC, baseArgs(armA, { keepCheckpoints: true }), { cueProvider, runPipeline: run });
  expect(result.entry?.outcome).toBe("generated");
}

describe("GV-62 the stage order and the cut", () => {
  /* MUTATION: put identity before spine in CHECKPOINT_STAGE_ORDER (a rerun
     from the spine then keeps an identity whose topic may have come from the
     old spine). Ran it: red. MUTATION: `at > from` in stagesAtOrAfter (the
     rerun stage itself is kept). Ran it: red. */
  it("stagesAtOrAfter(..., 'spine') keeps the order and drops spine, identity and every act-indexed key after it", () => {
    const keys = ["understand", "topic", "research-shape", "spine", "identity", "deepen:0", "source", "narrate:0", "stitch:0"];
    expect(stagesAtOrAfter(keys, "spine")).toEqual(["spine", "identity", "deepen:0", "source", "narrate:0", "stitch:0"]);
    expect(stagesAtOrAfter(keys, "narrate")).toEqual(["narrate:0", "stitch:0"]);
    expect(stagesAtOrAfter(keys, "understand")).toEqual(keys);
    expect(stagesAtOrAfter(["deepen:0", "deepen:1", "narrate:1", "narrate:0"], "deepen")).toEqual(["deepen:0", "deepen:1", "narrate:1", "narrate:0"]);
  });

  /* MUTATION: return false for a key whose stage is not in the order (an
     unplaceable key is kept). Ran it: red. MUTATION: drop the throw. Ran it:
     red. */
  it("throws on an unknown stage, and drops a key it cannot place", () => {
    expect(() => stagesAtOrAfter(["spine"], "narration")).toThrow(/unknown checkpoint stage "narration"/);
    expect(stagesAtOrAfter(["understand", "legacy-stage", "spine"], "spine")).toEqual(["legacy-stage", "spine"]);
  });

  /* MUTATION: delete "research-shape" from CHECKPOINT_STAGE_ORDER. Ran it:
     red (the scan finds it banked). The second half fails if the scan stops
     matching (a vacuous scan would pass anything). */
  it("every key runPipeline.ts banks has its stage in CHECKPOINT_STAGE_ORDER, and the scan sees all nine", () => {
    const source = fs.readFileSync(path.join(__dirname, "..", "src", "generation", "runPipeline.ts"), "utf8");
    const patterns = [
      /\b(?:stage|stageDetail)(?:<[^>(]*>)?\(\s*["'`]([^"'`$]+)/g,
      /\bcheckpoint\.(?:stage|save|resumeSync|has)\(\s*["'`]([^"'`$]+)/g
    ];
    const stages = new Set<string>();
    for (const pattern of patterns) for (const m of source.matchAll(pattern)) stages.add(m[1]!.split(":")[0]!);
    const unknown = [...stages].filter((s) => !(CHECKPOINT_STAGE_ORDER as readonly string[]).includes(s));
    expect(unknown, "runPipeline.ts banks a stage CHECKPOINT_STAGE_ORDER does not list").toEqual([]);
    expect([...stages].sort()).toEqual([...CHECKPOINT_STAGE_ORDER].sort());
  });

  it("names, for every routed stage, the first banked stage it feeds", () => {
    expect(Object.keys(ROUTED_STAGE_FIRST_CHECKPOINT).sort()).toEqual([...GENERATION_STAGES].sort());
    for (const stage of Object.values(ROUTED_STAGE_FIRST_CHECKPOINT)) expect(CHECKPOINT_STAGE_ORDER).toContain(stage);
  });
});

describe("GV-62 the fork rule", () => {
  const flags = resolvePipelineFlags({}, {});
  const stub = resolveRouting({});
  const local = (overrides: Record<string, string> = {}) =>
    resolveRouting({
      FORAY_GENERATION_MODE: "local",
      FORAY_LLM_BASE_URL: "http://litellm.invalid:4000",
      FORAY_ALLOW_PROSE_ON_SECOND: "1",
      ...overrides
    });
  const stampOf = (routing = stub, duration = "medium") => checkpointForkStamp({ prompt: SPEC.prompt, duration, flags, routing });
  const seedOf = (stamp: unknown, fingerprint = "seed-fp", version = CHECKPOINT_VERSION) => ({ version, fingerprint, fork: stamp });

  /* MUTATION: drop the version check. Ran it: red. MUTATION: accept on the
     exact fingerprint before the version check. Ran it: red. */
  it("accepts this run's own fingerprint, and refuses another checkpoint version even then", () => {
    const run = { fingerprint: "fp-1", stamp: stampOf() };
    expect(forkSeedRefusal(seedOf(undefined, "fp-1"), run, "narrate")).toBeNull();
    expect(forkSeedRefusal(seedOf(undefined, "fp-1", CHECKPOINT_VERSION - 1), run, "narrate")).toMatch(/checkpoint version 2/);
  });

  /* MUTATION: accept any stamped seed whatever its request (skip the request
     check). Ran it: red. */
  it("refuses a different fingerprint without a stamp, or with a stamp for another request or other flags", () => {
    const run = { fingerprint: "fp-1", stamp: stampOf() };
    expect(forkSeedRefusal(seedOf(undefined), run, "narrate")).toMatch(/no fork stamp/);
    expect(forkSeedRefusal(seedOf(stampOf(stub, "long")), run, "narrate")).toMatch(/different prompt, duration or topic/);
    expect(forkSeedRefusal(seedOf({ ...stampOf(), flags: "foldCopy" }), run, "narrate")).toMatch(/other pipeline flags/);
  });

  /* MUTATION: compare against `<=` instead of `<` (a writer swap could not
     fork from narrate). Ran it: red. MUTATION: drop the per-route loop
     (a spine swap would fork from narrate and keep the old spine). Ran it:
     red. MUTATION: map writer to "stitch" in ROUTED_STAGE_FIRST_CHECKPOINT
     (a writer swap could fork from stitch and keep the old narration). Ran
     it: red. */
  it("accepts a stamped seed whose differing routes all feed stages at or after --rerun-from, and refuses one that feeds a kept stage", () => {
    const a = local();
    const writerSwap = local({ FORAY_STAGE_WRITER: "local:second" });
    const spineSwap = local({ FORAY_STAGE_SPINE: "local:second" });
    expect(stampOf(a).routes.writer).not.toBe(stampOf(writerSwap).routes.writer);
    expect(forkSeedRefusal(seedOf(stampOf(a)), { fingerprint: "b", stamp: stampOf(writerSwap) }, "narrate")).toBeNull();
    expect(forkSeedRefusal(seedOf(stampOf(a)), { fingerprint: "b", stamp: stampOf(writerSwap) }, "stitch")).toMatch(
      /stage writer is routed differently .* feeds narrate, before --rerun-from stitch/
    );
    expect(forkSeedRefusal(seedOf(stampOf(a)), { fingerprint: "b", stamp: stampOf(spineSwap) }, "narrate")).toMatch(
      /stage spine is routed differently .* feeds spine, before --rerun-from narrate/
    );
    expect(forkSeedRefusal(seedOf(stampOf(a)), { fingerprint: "b", stamp: stampOf(spineSwap) }, "spine")).toBeNull();
    expect(() => forkSeedRefusal(seedOf(stampOf(a)), { fingerprint: "b", stamp: stampOf(a) }, "nope")).toThrow(/unknown checkpoint stage/);
  });

  it("the stamp carries the prompt only as a hash, and no URL or key", () => {
    const stamp = stampOf(local({ FORAY_LLM_API_KEY: "sk-secret-value" }));
    const text = JSON.stringify(stamp);
    expect(stamp.request).toBe(checkpointFingerprint({ prompt: SPEC.prompt, duration: "medium" }));
    expect(text).not.toContain("grilling");
    expect(text).not.toContain("litellm.invalid");
    expect(text).not.toContain("sk-secret-value");
  });
});

describe("GV-62 the CLI flags", () => {
  /* MUTATION: always set keepCheckpoints. Ran it: red. MUTATION: drop each
     refusal in parseForkFlags in turn. Ran the rerun-without-seed and the
     dry-run ones: red. */
  it("parses --keep-checkpoints, --seed-checkpoints and --rerun-from, absent unless given", () => {
    const plain = parseArgs(["--prompts", "p.json"], {});
    expect(plain.keepCheckpoints).toBeUndefined();
    expect("seedCheckpoints" in plain || "rerunFrom" in plain || "keepCheckpoints" in plain).toBe(false);
    expect(parseArgs(["--prompts", "p.json", "--keep-checkpoints"], {}).keepCheckpoints).toBe(true);
    const forked = parseArgs(["--prompts", "p.json", "--out", "B", "--seed-checkpoints", "A", "--rerun-from", "narrate"], {});
    expect(forked.seedCheckpoints).toBe("A");
    expect(forked.rerunFrom).toBe("narrate");
  });

  it("refuses --rerun-from alone, a seed without a stage, an unknown stage, --no-resume, --dry-run and a seed equal to --out", () => {
    const refuse = (argv: string[]) => () => parseArgs(["--prompts", "p.json", "--out", "B", ...argv], {});
    expect(refuse(["--rerun-from", "narrate"])).toThrow(/--rerun-from needs --seed-checkpoints/);
    expect(refuse(["--seed-checkpoints", "A"])).toThrow(/--seed-checkpoints needs --rerun-from/);
    expect(refuse(["--seed-checkpoints", "A", "--rerun-from", "narration"])).toThrow(/not a checkpoint stage; expected one of understand, topic/);
    expect(refuse(["--seed-checkpoints", "A", "--rerun-from", "narrate", "--no-resume"])).toThrow(/--no-resume/);
    expect(refuse(["--seed-checkpoints", "A", "--rerun-from", "narrate", "--dry-run"])).toThrow(/--dry-run/);
    expect(refuse(["--seed-checkpoints", "B", "--rerun-from", "narrate"])).toThrow(/not this run's --out/);
    expect(refuse(["--seed-checkpoints", "--rerun-from", "narrate"])).toThrow(/--seed-checkpoints needs a value/);
  });

  /* MUTATION: `findIndex(spec => spec.bench === false)` (a spec with no
     bench field passes). Ran it: red. */
  it("benchFlagRefusal refuses the fork flags unless every prompt is a bench prompt", () => {
    const bench = [{ prompt: "a", bench: true }, { prompt: "b", bench: true }];
    expect(benchFlagRefusal({}, [{ prompt: "a" }])).toBeNull();
    expect(benchFlagRefusal({ keepCheckpoints: true }, bench)).toBeNull();
    expect(benchFlagRefusal({ keepCheckpoints: true }, [...bench, { prompt: "c" }])).toMatch(/--keep-checkpoints is for bench prompts only: prompt 3 of 3/);
    expect(benchFlagRefusal({ seedCheckpoints: "A" }, [{ prompt: "c", bench: false }])).toMatch(/--seed-checkpoints is for bench prompts only/);
  });

  /* MUTATION: delete the benchFlagRefusal check in main. Ran it: red (the
     MODE line is printed and the run starts). */
  it("main exits 1 for --keep-checkpoints with a non-bench prompt, before anything is resolved or run", async () => {
    const prompts = path.join(root, "prompts.json");
    fs.writeFileSync(prompts, JSON.stringify([{ prompt: "a listener's prompt" }]));
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const before = process.exitCode;
    try {
      await main(["--prompts", prompts, "--out", armA, "--keep-checkpoints"]);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = before;
    }
    expect(String(err.mock.calls[0]![0])).toMatch(/--keep-checkpoints is for bench prompts only/);
    expect(log).not.toHaveBeenCalled();
    expect(fs.readdirSync(armA)).toEqual([]);
  });
});

describe("GV-62 the driver: keep, then fork", () => {
  /* MUTATION: leave the success-path discard unconditional. Ran it: red (no
     file beside the candidate). MUTATION: keep without the stamp. Ran it:
     red. */
  it("--keep-checkpoints leaves <key>.checkpoint.json beside a bench candidate, stamped; without it the file is deleted", async () => {
    await runArmA();
    expect(fs.existsSync(path.join(armA, candidateFilename(SPEC.prompt)))).toBe(true);
    const kept = readJson(checkpointPath(armA));
    expect(kept.version).toBe(CHECKPOINT_VERSION);
    expect(Object.keys(kept.stages)).toEqual(expect.arrayContaining(["understand", "spine", "source", "narrate:0", "stitch:0"]));
    expect((kept.fork as { request: string }).request).toBe(checkpointFingerprint({ prompt: SPEC.prompt, duration: "short" }));

    const { run } = countingPipeline();
    await generateOneCandidate(SPEC, baseArgs(armB), { cueProvider, runPipeline: run });
    expect(fs.existsSync(checkpointPath(armB))).toBe(false);
  }, 60_000);

  /* MUTATION: skip the store.drop call in seedCheckpoint (every stage is
     resumed, the writer is never called). Ran it: red. MUTATION: drop with
     stagesAtOrAfter(keys, "understand"). Ran it: red (the understander,
     spine and deepen builders are called). */
  it("a seeded run with --rerun-from narrate calls no understander, spine or deepen builder, drops narrate and stitch, and records seededFrom", async () => {
    await runArmA();
    const aStages = Object.keys(readJson(checkpointPath(armA)).stages);
    const drop = vi.spyOn(FileCheckpointStore.prototype, "drop");
    const { run, counts } = countingPipeline();
    const result = await generateOneCandidate(SPEC, baseArgs(armB, { seedCheckpoints: armA, rerunFrom: "narrate" }), {
      cueProvider,
      runPipeline: run
    });

    expect(result.entry?.outcome).toBe("generated");
    expect(counts.understand).toBe(0);
    expect(counts.spine).toBe(0);
    expect(counts.deepen).toBe(0);
    expect(counts.writer).toBeGreaterThan(0);
    const dropped = aStages.filter((k) => /^(narrate|stitch):/.test(k));
    expect(dropped.length).toBeGreaterThan(0);
    expect(drop).toHaveBeenCalledWith(keyOf(SPEC.prompt), dropped);
    expect(result.entry?.seededFrom).toEqual({ dir: armA, rerunFrom: "narrate", stagesKept: aStages.filter((k) => !dropped.includes(k)) });
    expect(result.entry?.seededFrom?.stagesKept).toEqual(expect.arrayContaining(["understand", "spine", "identity", "source"]));
    /* Arm A's file is never touched. */
    expect(Object.keys(readJson(checkpointPath(armA)).stages)).toEqual(aStages);
  }, 60_000);

  /* MUTATION: require the exact fingerprint only (ignore the stamp). Ran it:
     red (an arm that routes a stage by --stage-provider has another
     fingerprint and is never seeded). */
  it("forks across a routing difference through the stamp: arm B's --stage-provider gives it another fingerprint", async () => {
    await runArmA();
    const { run, counts } = countingPipeline();
    const result = await generateOneCandidate(
      SPEC,
      baseArgs(armB, { seedCheckpoints: armA, rerunFrom: "narrate", stageProviders: { writer: "stub" }, keepCheckpoints: true }),
      { cueProvider, runPipeline: run }
    );
    expect(readJson(checkpointPath(armB)).fingerprint).not.toBe(readJson(checkpointPath(armA)).fingerprint);
    expect(result.entry?.seededFrom?.rerunFrom).toBe("narrate");
    expect(counts.spine).toBe(0);
    expect(counts.writer).toBeGreaterThan(0);
  }, 60_000);

  /* MUTATION: return the seed even when forkSeedRefusal refuses it. Ran it:
     red. MUTATION: skip the discard in `unseeded` (B resumes its own stale
     checkpoint). Ran it: red. */
  it("a version- or fingerprint-mismatched seed is ignored, logged, and recorded as seededFrom: null; the prompt runs from scratch", async () => {
    await runArmA();
    const seedFile = checkpointPath(armA);
    const good = readJson(seedFile);
    const log = vi.spyOn(console, "log");

    fs.writeFileSync(seedFile, JSON.stringify({ ...good, version: CHECKPOINT_VERSION + 1 }));
    /* A stale checkpoint already in B's --out must not be resumed either. */
    fs.writeFileSync(checkpointPath(armB), JSON.stringify({ ...good, fork: undefined }));
    const first = countingPipeline();
    const versioned = await generateOneCandidate(SPEC, baseArgs(armB, { seedCheckpoints: armA, rerunFrom: "narrate" }), {
      cueProvider,
      runPipeline: first.run
    });
    expect(versioned.entry?.seededFrom).toBeNull();
    expect(first.counts.spine).toBeGreaterThan(0);
    expect(first.counts.understand).toBeGreaterThan(0);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/no usable seed .*checkpoint version 4, this build reads 3/);

    fs.rmSync(path.join(armB, candidateFilename(SPEC.prompt)));
    const { fork: _fork, ...unstamped } = good;
    void _fork;
    fs.writeFileSync(seedFile, JSON.stringify({ ...unstamped, fingerprint: "not-this-run" }));
    const second = countingPipeline();
    const mismatched = await generateOneCandidate(SPEC, baseArgs(armB, { seedCheckpoints: armA, rerunFrom: "narrate" }), {
      cueProvider,
      runPipeline: second.run
    });
    expect(mismatched.entry?.seededFrom).toBeNull();
    expect(second.counts.spine).toBeGreaterThan(0);
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/no usable seed .*no fork stamp/);
  }, 60_000);

  it("a missing seed is logged and recorded as seededFrom: null; without the flag the row has no seededFrom", async () => {
    const log = vi.spyOn(console, "log");
    const { run } = countingPipeline();
    const missing = await generateOneCandidate(SPEC, baseArgs(armB, { seedCheckpoints: armA, rerunFrom: "spine" }), { cueProvider, runPipeline: run });
    expect(missing.entry?.seededFrom).toBeNull();
    expect(log.mock.calls.map((c) => String(c[0])).join("\n")).toMatch(/no usable seed .*does not exist/);

    const plain = await generateOneCandidate({ prompt: "another bench prompt", bench: true }, baseArgs(armB), {
      cueProvider,
      runPipeline: countingPipeline().run
    });
    expect(plain.entry && "seededFrom" in plain.entry).toBe(false);
  }, 60_000);
});
