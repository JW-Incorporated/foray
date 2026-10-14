import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { anthropicRuleViolation, batchReportDocument, batchSummaryText, corpusReport, generateOneCandidate, main, parseArgs, partialCandidateFilename, candidateFilename, readPromptSet, type CliArgs, type ReportEntry } from "../src/cli/generateForays";
import { corpusCoverage, corpusFingerprint, corpusSafeKey } from "../src/generation/transcriptCorpus";
import { TRANSCRIPT_TEXT_INDEX_VERSION } from "../src/generation/transcriptTextIndex";
import { createHash } from "node:crypto";
import { evaluateVeracityGate, type VeracityGateResult } from "../src/generation/veracityMetrics";
import type { ItemReadyEvent } from "../src/generation/deliveryTimeline";
import { runForayPipeline } from "../src/generation/runPipeline";
import type Anthropic from "@anthropic-ai/sdk";
import { createMessage } from "../src/generation/anthropicCall";
import { FileTranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { PartialCandidate } from "../src/generation/partialCandidate";
import { CheckpointSession, checkpointFingerprint, checkpointRunVariant } from "../src/generation/checkpoint";
import { resolveRouting, routingSummary } from "../src/config/stageRouting";
import { FAST_PATH_PIPELINE_FLAGS, PIPELINE_FLAG_ENV, checkpointVariant, readPipelineFlags, type FoldDeepen } from "../src/generation/pipelineFlags";
import { readGateConfig } from "../src/generation/gateConfig";
import { JobSnapshotSchema, type JobSnapshot } from "../src/generation/jobSink";
import { SpoolRenderClient, renderJobDocument } from "../src/cli/spoolRenderClient";
import type { NarrationRenderClient, RenderJob, RenderResult } from "../src/generation/narrationRender";
import type { PromptUnderstandContext } from "../src/generation/PromptUnderstander";
import type { IntentUnderstanding } from "../src/types/generation";

/**
 * WS-D2's own "exercisable without an API key" requirement (fix plan, D2):
 * drives the REAL `runForayPipeline`, with Stub builders bound explicitly
 * (never relying on the ambient shell having no `ANTHROPIC_API_KEY` — the
 * same discipline `runPipeline.test.ts`'s own `stubDeps()` uses), through
 * the ACTUAL `generateOneCandidate` the CLI's `main()` calls per prompt.
 *
 * `stubPipeline()` also binds a FAKE `finalize` by default — same reason
 * `runPipeline.test.ts`'s `stubDeps()` does (see its own comment on
 * `RunPipelineDeps.finalize`): `buildPartialCandidate` (WS-D2) calls
 * `finalize` once per act, and the real `finalizeForay` dynamic-`import()`s
 * `tools/foray/*.mjs`, which Vitest cannot resolve on a Windows checkout
 * whose path contains a space — not a quick reject, but a promise that
 * never settles, so a test using the real one here would hang until
 * timeout on exactly this machine. `stubPipeline(FAKE_FINALIZE)` is what
 * every mechanics test below uses; the one test that needs the REAL
 * validator (`checkersLoadable`-gated, mirroring `runPipeline.test.ts`'s
 * own pattern) asks for `stubPipeline()` with no override.
 */

const cueProvider = new FileTranscriptCueProvider();

/** Mirrors `runPipeline.test.ts`'s own `recordingFinalize()` — a clean pass,
 * every time, with no dynamic import. */
const FAKE_FINALIZE = async (input: FinalizeForayInput): Promise<FinalizeForayResult> => ({
  validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
  forayRecord: { id: input.id, generated: true },
  timings: []
});

function stubPipeline(finalize: typeof FAKE_FINALIZE | undefined = FAKE_FINALIZE): typeof runForayPipeline {
  return (request, options, deps = {}) =>
    runForayPipeline(request, options, {
      understander: new StubPromptUnderstander(),
      researcher: new StubExternalResearcher(),
      spineBuilder: new StubSpineBuilder(),
      deepenBuilder: new StubDeepenActBuilder(),
      narrationWriter: new StubNarrationWriterBuilder(),
      narrationVerifier: new StubNarrationVerifierBuilder(),
      continuityBuilder: new StubContinuityBuilder(),
      ...(finalize !== undefined ? { finalize } : {}),
      ...deps
    });
}

/** Can this checkout load the real `.mjs` checkers `finalizeForay` (and
 * therefore `buildPartialCandidate`) calls into? Mirrors
 * `runPipeline.test.ts`'s own `checkersLoadable`. */
async function checkersLoadable(): Promise<boolean> {
  const { finalizeForay } = await import("../src/generation/finalizeForay");
  try {
    await finalizeForay({ id: "probe-only", title: "t", topic: "food/grilling-bbq", summary: "s", slots: [], items: [], runtimeSec: 0 });
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return !/Invalid or unexpected token|Failed to load url|dynamic import callback/.test(msg);
  }
}

function baseArgs(out: string, overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompts: null,
    out,
    duration: "medium", // multiple acts (stub spine: midpoint([3,4]) = 4) so intermediate partial writes are observable
    limit: null,
    dryRun: false,
    authorId: "founder-1",
    /* WS-F's own two flags (F-04/F-17/F-18), defaulted to "behave as the
       pipeline did before checkpoints existed": no imposed cap, and resume
       allowed. The per-prompt checkpoint store `generateOneCandidate` builds
       from them writes into the same throwaway `dir` these tests already own. */
    budgetUsd: null,
    noResume: false,
    /* G-30 defaults: single attempt is NOT the default any more, but these
       tests never throw, so three resumes and an abort-on-refusal are inert. */
    maxResumes: 3,
    continueOnRefusedPartial: false,
    notify: null,
    ...overrides
  };
}

describe("generateOneCandidate — WS-D2 partial-file mechanics", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-candidates-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("writes the partial file after Act 1, rewrites it on every later act, and records ttlA1Ms", async () => {
    const spec = { prompt: "the history of grilling and barbecue" };
    const args = baseArgs(dir);
    const partialFile = path.join(dir, partialCandidateFilename(spec.prompt));

    const writes: PartialCandidate[] = [];
    const onDiskAtEachWrite: PartialCandidate[] = [];

    const result = await generateOneCandidate(spec, args, {
      cueProvider,
      runPipeline: stubPipeline(),
      onPartialWrite: (candidate, file) => {
        expect(file).toBe(partialFile);
        /* Checked HERE, synchronously, at write time — not after the whole
           `generateOneCandidate` call resolves. On success the CLI deletes
           the partial file once the real candidate is written (its job is
           done — see `generateOneCandidate`'s own comment), so asserting
           existence after the fact would wrongly fail on exactly the happy
           path this test is proving works. */
        expect(fs.existsSync(file)).toBe(true);
        writes.push(candidate);
        /* The write is synchronous (`fs.writeFileSync` happens before this
           hook fires) — reading it back here is the actual "rewritten on
           disk" assertion, not just an in-memory callback argument. */
        onDiskAtEachWrite.push(JSON.parse(fs.readFileSync(file, "utf8")) as PartialCandidate);
      }
    });

    /* MUTATION THAT KILLS THIS: fire `onActReady` only for the LAST act (or
       not at all). `writes.length` would be 1 (or 0) instead of one per act.
       Ran it — red. */
    expect(writes.length).toBeGreaterThan(1);

    // Act 1 (index 0): private, and ttlA1Ms is a real, non-negative
    // measurement. (Existence-on-disk at write time is already asserted
    // inside the hook above, for every write including this one.)
    const first = writes[0]!;
    expect(first.visibility).toBe("private");
    expect(first.authorId).toBe("founder-1");
    expect(first.acts[0]!.status).toBe("ready");
    expect(first.acts.slice(1).every((a) => a.status === "pending")).toBe(true);
    expect(first.status).toBe("partial");
    expect(typeof first.ttlA1Ms).toBe("number");
    expect(first.ttlA1Ms).toBeGreaterThanOrEqual(0);

    // Every later write is a REWRITE of the same file — the same
    // ttlA1Ms carried forward unchanged (set once, per `runPipeline.ts`'s
    // own doc comment), and each write shows one more act "ready" than the
    // last, until the final write is "complete".
    for (let i = 1; i < writes.length; i++) {
      expect(writes[i]!.ttlA1Ms).toBe(first.ttlA1Ms);
      const readyCount = writes[i]!.acts.filter((a) => a.status === "ready").length;
      const prevReadyCount = writes[i - 1]!.acts.filter((a) => a.status === "ready").length;
      expect(readyCount).toBe(prevReadyCount + 1);
    }
    const last = writes[writes.length - 1]!;
    expect(last.status).toBe("complete");
    expect(last.acts.every((a) => a.status === "ready")).toBe(true);

    // What actually landed on disk at each point matches what the hook saw
    // in memory — proving the rewrite is real, not just an argument.
    expect(onDiskAtEachWrite).toEqual(writes);

    // The pipeline finished (skipped only when a candidate already exists,
    // which is not this test's case) and, on success, the partial file is
    // cleaned up — its job (letting the requesting listener start early)
    // is done once the real candidate exists.
    expect(result.skipped).toBe(false);
    if (result.entry?.file) {
      expect(fs.existsSync(partialFile)).toBe(false);
      expect(fs.existsSync(result.entry.file)).toBe(true);
      const written = JSON.parse(fs.readFileSync(result.entry.file, "utf8")) as FinalizeForayInput;
      expect(written.id).toBe(last.id);
    }

    // report.json's own field, per §4.9/D2 ("measure it and print ttlA1Ms
    // in the report"): the entry this CLI would push into report.json
    // carries the same measurement the partial candidate did.
    expect(result.entry?.ttlA1Ms).toBe(first.ttlA1Ms);

    /* G-32: the same entry says how many acts narrated at once and carries
       one `narrate:<i>` timing per act — one row per partial write above. */
    expect(result.entry?.narrationConcurrency).toBeGreaterThanOrEqual(1);
    expect(result.entry?.narrationActs?.map((a) => a.act)).toEqual(writes.map((_w, i) => i));
  });

  it("writes nothing under --dry-run", async () => {
    const spec = { prompt: "a completely different dry run prompt" };
    const args = baseArgs(dir, { dryRun: true });
    const partialFile = path.join(dir, partialCandidateFilename(spec.prompt));

    await generateOneCandidate(spec, args, { cueProvider, runPipeline: stubPipeline() });

    expect(fs.existsSync(partialFile)).toBe(false);
    expect(fs.existsSync(path.join(dir, candidateFilename(spec.prompt)))).toBe(false);
  });

  it("skips a prompt whose final candidate already exists, without touching the partial file", async () => {
    const spec = { prompt: "an already-built prompt" };
    const args = baseArgs(dir);
    fs.writeFileSync(path.join(dir, candidateFilename(spec.prompt)), "{}");

    const onPartialWrite = (): void => {
      throw new Error("must not run the pipeline for an already-built prompt");
    };
    const result = await generateOneCandidate(spec, args, { cueProvider, runPipeline: stubPipeline(), onPartialWrite });

    expect(result.skipped).toBe(true);
  });
});

describe("generateOneCandidate — against the real §4.9 validator", () => {
  it("the partial candidate's validation comes from the real check-forays/check-narration, not a stand-in", async () => {
    if (!(await checkersLoadable())) {
      console.warn(
        "SKIPPED: this checkout cannot load tools/foray/*.mjs under Vitest " +
          "(path contains a space; see RunPipelineDeps.finalize). CI runs this test."
      );
      return;
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-candidates-real-"));
    try {
      const spec = { prompt: "the real history of grilling and barbecue, unfaked" };
      const args = baseArgs(dir);
      let sawValidation = false;
      await generateOneCandidate(spec, args, {
        cueProvider,
        runPipeline: stubPipeline(undefined),
        onPartialWrite: (candidate) => {
          sawValidation = true;
          expect(Array.isArray(candidate.validation.checkForaysErrors)).toBe(true);
        }
      });
      expect(sawValidation).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});


describe("the batch driver arms the per-Foray budget cap (requirements §8.10)", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-candidates-session-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("passes a sessionId, and it is the checkpoint key", async () => {
    /* `BudgetGuard.checkAndRecord` only compares a Foray's own spend
       against EPISODE_BUDGET_USD when the call carries a `sessionId`. This
       driver passed none, so the per-Foray cap was inert in the only path
       that generates anything: a runaway Foray was bounded by the DAILY
       cap alone. The checkpoint key is one id per Foray, stable across a
       resume, and already the name a human sees when a run stops. */
    const spec = { prompt: "the history of grilling and barbecue" };
    const args = baseArgs(dir);

    let seen: Parameters<typeof runForayPipeline>[1] | null = null;
    await generateOneCandidate(spec, args, {
      cueProvider,
      runPipeline: (request, options, deps) => {
        seen = options;
        return stubPipeline()(request, options, deps);
      }
    });

    const options = seen as unknown as { sessionId?: string; checkpointKey?: string };
    expect(typeof options.sessionId).toBe("string");
    expect(options.sessionId!.length).toBeGreaterThan(0);
    expect(options.sessionId).toBe(options.checkpointKey);
  });
});

/* GV-15 (docs/roadmap/generation-v2.md, decision 20): the checkpoint variant
   at BOTH fingerprint call sites, and the resolved flags and gates on the
   report row. A run "killed after its spine" is a deepen builder that throws
   a fatal error: the driver records an `error` row and keeps the checkpoint,
   which holds every stage up to and including the spine. */
describe("GV-15 — run configuration on the batch driver", () => {
  let dir: string;
  const spec = { prompt: "the history of grilling and barbecue" };

  class CountingSpineBuilder extends StubSpineBuilder {
    calls = 0;
    override async buildSpine(...args: Parameters<StubSpineBuilder["buildSpine"]>): ReturnType<StubSpineBuilder["buildSpine"]> {
      this.calls++;
      return super.buildSpine(...args);
    }
  }
  class KilledAfterSpine extends StubDeepenActBuilder {
    override async deepenAct(): Promise<never> {
      throw new Error("killed after spine");
    }
  }

  const checkpointFile = (): string => path.join(dir, `${candidateFilename(spec.prompt).replace(/\.json$/, "")}.checkpoint.json`);
  const readCheckpoint = (): { fingerprint: string; stages: Record<string, unknown> } => JSON.parse(fs.readFileSync(checkpointFile(), "utf8"));
  const args = (overrides: Partial<CliArgs> = {}): CliArgs => baseArgs(dir, { duration: "short", maxResumes: 0, ...overrides });
  const run = (spine: CountingSpineBuilder, killAfterSpine: boolean, overrides: Partial<CliArgs> = {}) =>
    generateOneCandidate(spec, args(overrides), {
      cueProvider,
      runPipeline: (request, options, deps) =>
        stubPipeline()(request, options, { ...deps, spineBuilder: spine, ...(killAfterSpine ? { deepenBuilder: new KilledAfterSpine() } : {}) })
    });

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-candidates-gv15-"));
    for (const name of Object.values(PIPELINE_FLAG_ENV)) delete process.env[name];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const name of Object.values(PIPELINE_FLAG_ENV)) delete process.env[name];
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* Kills: parseArgs ignoring --fast-path, or adding a `fastPath: false`
     key to every parse (the parsed args of a run without it must not move). */
  it("parses --fast-path, and adds nothing without it", () => {
    expect(parseArgs(["--prompts", "p.json", "--fast-path"]).fastPath).toBe(true);
    expect("fastPath" in parseArgs(["--prompts", "p.json"])).toBe(false);
  });

  /* Kills: dropping `gates` (or `flags`) from the row finishEntry builds. */
  it("the report row carries the resolved gates and flags objects", async () => {
    const result = await run(new CountingSpineBuilder(), false);
    expect(result.entry?.outcome).toBe("generated");
    expect(result.entry?.gates).toEqual(readGateConfig({}));
    expect(result.entry?.flags).toEqual(readPipelineFlags({}));
  });

  /* Kills: the variant at only one site (either side), or the driver and the
     pipeline resolving flags differently (e.g. --fast-path not reaching
     options.flags). The store's fingerprint is what it wrote into the file;
     the session's is what runForayPipeline passed to CheckpointSession.open. */
  it("the FileCheckpointStore and session fingerprints are equal for every flag combination", async () => {
    const open = vi.spyOn(CheckpointSession, "open");
    const combos: { env: Record<string, string>; fastPath?: boolean }[] = [{ env: {}, fastPath: true }];
    for (const copy of ["0", "1"]) {
      for (const deepen of ["off", "short", "all"] as FoldDeepen[]) {
        for (const perAct of ["0", "1"]) {
          combos.push({ env: { FORAY_SPINE_FOLD_COPY: copy, FORAY_SPINE_FOLD_DEEPEN: deepen, FORAY_PER_ACT_PIPELINE: perAct } });
        }
      }
    }
    const fingerprints = new Set<string>();
    for (const combo of combos) {
      for (const name of Object.values(PIPELINE_FLAG_ENV)) delete process.env[name];
      Object.assign(process.env, combo.env);
      open.mockClear();
      fs.rmSync(checkpointFile(), { force: true });
      const result = await run(new CountingSpineBuilder(), true, combo.fastPath ? { fastPath: true } : {});
      expect(result.entry?.outcome, JSON.stringify(combo)).toBe("error");
      const sessionFingerprint = open.mock.calls[0]![2];
      expect(readCheckpoint().fingerprint, JSON.stringify(combo)).toBe(sessionFingerprint);
      fingerprints.add(sessionFingerprint);
      if (combo.fastPath) {
        /* --fast-path reached both sites as the umbrella, not as a bare field. */
        /* GV-55: the fast path narrates in order, so its variant also names
           the narration order (and no longer shares foldCopy+short+perAct's). */
        expect(sessionFingerprint).toBe(checkpointFingerprint({ prompt: spec.prompt, duration: "short", variant: checkpointRunVariant(FAST_PATH_PIPELINE_FLAGS) }));
      }
    }
    /* 12 env combinations, plus --fast-path's own (sequential narration). */
    expect(fingerprints.size).toBe(13);
    expect(fingerprints.has(checkpointFingerprint({ prompt: spec.prompt, duration: "short" }))).toBe(true);
  });

  /* Kills: the variant on the session only (the session's fingerprint would
     never match the file the store wrote, so the spine is rebuilt). */
  it("(a) a flag-on run killed after its spine resumes its own banked stages", async () => {
    process.env.FORAY_SPINE_FOLD_COPY = "1";
    const first = new CountingSpineBuilder();
    expect((await run(first, true)).entry?.outcome).toBe("error");
    expect(first.calls).toBe(1);
    const second = new CountingSpineBuilder();
    const result = await run(second, false);
    expect(result.entry?.outcome).toBe("generated");
    expect(second.calls).toBe(0);
  });

  /* Kills: the variant on the store only, or no variant at all (then the
     classic stages would resume under the flag, and the file would merge). */
  it("(b) a classic run and a flag-on run never load each other's banked stages", async () => {
    const classicFingerprint = checkpointFingerprint({ prompt: spec.prompt, duration: "short" });
    const flagOnFingerprint = checkpointFingerprint({ prompt: spec.prompt, duration: "short", variant: checkpointVariant({ foldSpineCopy: true, foldDeepen: "off", perActPipeline: false }) });
    expect(flagOnFingerprint).not.toBe(classicFingerprint);
    const open = vi.spyOn(CheckpointSession, "open");

    for (const [firstMode, secondMode] of [["classic", "flag-on"], ["flag-on", "classic"]] as const) {
      fs.rmSync(checkpointFile(), { force: true });
      const setMode = (mode: "classic" | "flag-on"): void => {
        if (mode === "flag-on") process.env.FORAY_SPINE_FOLD_COPY = "1";
        else delete process.env.FORAY_SPINE_FOLD_COPY;
      };
      setMode(firstMode);
      expect((await run(new CountingSpineBuilder(), true)).entry?.outcome).toBe("error");
      const firstStages = Object.keys(readCheckpoint().stages).sort();
      expect(firstStages.length).toBeGreaterThan(0);

      setMode(secondMode);
      open.mockClear();
      const second = new CountingSpineBuilder();
      expect((await run(second, true)).entry?.outcome).toBe("error");
      /* Started from an empty stage set: nothing resumed, the spine rebuilt. */
      const session = (await open.mock.results[0]!.value) as CheckpointSession;
      expect(session.resumed(), `${firstMode} -> ${secondMode}`).toEqual([]);
      expect(second.calls).toBe(1);
      /* The file holds only the second run's mode. */
      const after = readCheckpoint();
      expect(after.fingerprint).toBe(secondMode === "flag-on" ? flagOnFingerprint : classicFingerprint);
      expect(Object.keys(after.stages).sort()).toEqual(firstStages);
    }
  });
});

describe("GV-26 — the report row carries the publish gate verdict and MQ-21 publishable", () => {
  let dir: string;
  const spec = { prompt: "the history of grilling and barbecue" };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-candidates-gv26-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The stub pipeline, with the outcome's gate verdict overridden — the
   * stub candidate fails the real gate, so a passing verdict is forced here. */
  const withGate = (pipeline: typeof runForayPipeline, gate: VeracityGateResult): typeof runForayPipeline =>
    async (request, options, deps) => {
      const out = await pipeline(request, options, deps);
      return out.outcome === "generated" ? { ...out, gate } : out;
    };
  const INVALID_FINALIZE = async (input: FinalizeForayInput): Promise<FinalizeForayResult> => ({
    ...(await FAKE_FINALIZE(input)),
    validation: { ok: false, checkForaysErrors: ["E1: refused"], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] }
  });

  it("a stub run's row carries gate equal to evaluateVeracityGate(meta.veracity), and a clean run is publishable", async () => {
    /* MUTATION THAT KILLS THIS: drop `gate` from the row (or write a constant
       one) — the first assertion goes red. Ran it — red. */
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await generateOneCandidate(spec, baseArgs(dir, { duration: "short", maxResumes: 0 }), { cueProvider, runPipeline: stubPipeline() });
    const entry = result.entry!;
    expect(entry.outcome).toBe("generated");
    expect(entry.gate).toBeDefined();
    expect(entry.gate).toEqual(evaluateVeracityGate(entry.veracity));
    expect(entry.gate?.ok).toBe(true);
    expect(entry.publishable).toBe(true);
  });

  it("publishable is false whenever the gate fails, and the run line names the first failure", async () => {
    /* MUTATION THAT KILLS THIS: `publishable: outcome.result.validation.ok` (drop
       `&& gate.ok`) — the candidate passes the fake validation and the row reads
       publishable true. Ran it — red. Dropping the `GATE FAIL` suffix from the
       run line fails the last assertion. */
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const fail: VeracityGateResult = { ok: false, failures: ["2 page(s) were kept without passing verification", "  [Patch] x — y"] };
    const result = await generateOneCandidate(spec, baseArgs(dir, { duration: "short", maxResumes: 0 }), {
      cueProvider,
      runPipeline: withGate(stubPipeline(), fail)
    });
    expect(result.entry?.gate).toEqual(fail);
    expect(result.entry?.publishable).toBe(false);
    const runLine = log.mock.calls.map((c) => String(c[0])).find((l) => l.includes("built "));
    expect(runLine).toMatch(/ GATE FAIL: 2 page\(s\) were kept without passing verification$/);
  });

  it("publishable is false when validation fails under a passing gate", async () => {
    /* MUTATION THAT KILLS THIS: `publishable: gate.ok` (drop the validation
       half) — the invalid candidate reads publishable true. Ran it — red. */
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const pass: VeracityGateResult = { ok: true, failures: [] };
    /* The fake validator refuses every partial too, so the run is told to go on. */
    const invalid = await generateOneCandidate(spec, baseArgs(dir, { duration: "short", maxResumes: 0, continueOnRefusedPartial: true }), {
      cueProvider,
      runPipeline: withGate(stubPipeline(INVALID_FINALIZE), pass)
    });
    expect(invalid.entry?.outcome).toBe("generated");
    expect(invalid.entry?.gate?.ok).toBe(true);
    expect(invalid.entry?.publishable).toBe(false);
    /* A passing gate adds nothing to the run line. */
    expect(log.mock.calls.map((c) => String(c[0])).some((l) => l.includes("GATE FAIL"))).toBe(false);
  });

  it("a row that never generated carries neither gate nor publishable", async () => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    const result = await generateOneCandidate(spec, baseArgs(dir, { duration: "short", maxResumes: 0 }), {
      cueProvider,
      runPipeline: async () => ({ outcome: "rejected", category: "unsafe", explanation: "no", timings: [] })
    });
    expect(result.entry?.outcome).toBe("rejected");
    expect(result.entry && "gate" in result.entry).toBe(false);
    expect(result.entry && "publishable" in result.entry).toBe(false);
  });

  it("the batch summary prints how many rows passed every gate without --force", () => {
    /* MUTATION THAT KILLS THIS: count `gate.ok` rows instead of `publishable`
       ones — the gate-passing but invalid row is counted and the line reads 2.
       Ran it — red. */
    const row = (publishable: boolean | undefined, gateOk?: boolean): ReportEntry => ({
      prompt: "p",
      outcome: "generated",
      detail: "OK x",
      ms: 0,
      ...(gateOk !== undefined ? { gate: { ok: gateOk, failures: gateOk ? [] : ["f"] } } : {}),
      ...(publishable !== undefined ? { publishable } : {})
    });
    const line = batchSummaryText({
      report: [row(true, true), row(false, true), row(false, false), row(undefined)],
      generated: 1,
      skipped: 0,
      aborts: 0,
      validCount: 3,
      resumesTotal: 0
    });
    expect(line).toBe("1 candidate(s) written, 0 skipped, 0 aborted, 1 did not produce a publishable Foray; 1 passed every gate (publishable without --force)");
  });
});

describe("GV-33 — the report row carries the delivery timeline", () => {
  let dir: string;
  const spec = { prompt: "the history of grilling and barbecue" };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-candidates-gv33-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The stub pipeline with its own item events replaced by a scripted
   * timeline: prelude and act 0 ready at 4 s, act 1 at 30 s (it plays at
   * 4 + 100 = 104 s, so 74 s ahead at 1x; at 1.5x 4 + 66.667 - 30 = 40.667 s). */
  const scripted =
    (resumedStitch = false): typeof runForayPipeline =>
    async (request, options, deps = {}) => {
      const { onItemReady, ...rest } = deps;
      const out = await stubPipeline()(request, options, rest);
      const item = { type: "narration", id: "x", script: "x", mode: "Frame" } as unknown as ItemReadyEvent["item"];
      const ev = (index: number, actIndex: number, readyAtMs: number, playStartSec: number): ItemReadyEvent => ({
        forayId: "f",
        index,
        itemId: `i${index}`,
        actIndex,
        check: "verified",
        servable: true,
        readyAtMs,
        playStartSec,
        durationSec: 10,
        item,
        granularity: "act"
      });
      for (const e of [ev(0, -1, 4_000, 0), ev(1, 0, 4_000, 10), ev(2, 1, 30_000, 100)]) await onItemReady?.(e);
      if (!resumedStitch) return out;
      return { ...out, timings: [...out.timings, { name: "stitch:0", startedAt: new Date(0).toISOString(), ms: 0, resumed: true as const }] };
    };

  it("a fresh run's row carries delivery.* with the lead at 1x and 1.5x", async () => {
    /* MUTATION THAT KILLS THIS: leave `onItemReady` out of the deps
       generateOneCandidate hands the pipeline. The timeline stays empty and
       the row has no delivery. Ran it — red. */
    const result = await generateOneCandidate(spec, baseArgs(dir, { duration: "short", maxResumes: 0 }), { cueProvider, runPipeline: scripted() });
    expect(result.entry?.outcome).toBe("generated");
    expect(result.entry?.delivery).toEqual({
      granularity: "act",
      items: 3,
      firstItemReadyMs: 4_000,
      firstServableMs: 4_000,
      allItemsReadyMs: 30_000,
      minLeadSec: 74,
      minLeadSecAt1_5x: 40.667,
      itemsBelow30s: 0,
      pausedAtIndex: null,
      unknownDurations: 0
    });
  });

  it("a run with a resumed act carries delivery.resumed and no lead", async () => {
    /* MUTATION THAT KILLS THIS: pass `false` for resumed to deliveryReportOf.
       The row then carries a lead measured over half a run. Ran it — red. */
    const result = await generateOneCandidate(spec, baseArgs(dir, { duration: "short", maxResumes: 0 }), { cueProvider, runPipeline: scripted(true) });
    expect(result.entry?.delivery).toEqual({ granularity: "act", items: 3, resumed: true });
  });

  it("the real stub pipeline's events reach the row: one per item of the candidate", async () => {
    const result = await generateOneCandidate(spec, baseArgs(dir, { duration: "short", maxResumes: 0 }), { cueProvider, runPipeline: stubPipeline() });
    expect(result.entry?.outcome).toBe("generated");
    const candidate = JSON.parse(fs.readFileSync(result.file!, "utf8")) as { items: unknown[] };
    expect(result.entry?.delivery?.items).toBe(candidate.items.length);
    expect(result.entry?.delivery?.minLeadSec).toBeDefined();
  });

  it("a row that never generated carries no delivery", async () => {
    const result = await generateOneCandidate(spec, baseArgs(dir, { duration: "short", maxResumes: 0 }), {
      cueProvider,
      runPipeline: async () => ({ outcome: "rejected", category: "unsafe", explanation: "no", timings: [] })
    });
    expect(result.entry && "delivery" in result.entry).toBe(false);
  });
});

/* GV-55 (decision 20, R2-21): the routing a run was resolved under reaches
   the report (top-level `routing` and `generationMode`, per-row
   `stageAssignments`) and joins the checkpoint variant at BOTH sites in local
   mode. Local mode here is FORAY_LLM_BASE_URL set to a synthetic URL with
   every builder a Stub injected through the pipeline's deps, so no stage
   factory runs and nothing opens a connection. */
describe("GV-55 — routing on the report and in the checkpoint fingerprint", () => {
  let dir: string;
  const LLM = "http://litellm.test:4000";
  const spec = { prompt: "the history of grilling and barbecue" };

  class CountingSpineBuilder extends StubSpineBuilder {
    calls = 0;
    override async buildSpine(...args: Parameters<StubSpineBuilder["buildSpine"]>): ReturnType<StubSpineBuilder["buildSpine"]> {
      this.calls++;
      return super.buildSpine(...args);
    }
  }
  class KilledAfterSpine extends StubDeepenActBuilder {
    override async deepenAct(): Promise<never> {
      throw new Error("killed after spine");
    }
  }

  const checkpointFile = (): string => path.join(dir, `${candidateFilename(spec.prompt).replace(/\.json$/, "")}.checkpoint.json`);
  const readCheckpoint = (): { fingerprint: string; stages: Record<string, unknown> } => JSON.parse(fs.readFileSync(checkpointFile(), "utf8"));
  const run = (spine: CountingSpineBuilder, killAfterSpine: boolean, overrides: Partial<CliArgs> = {}) => {
    const seen: { routing?: unknown }[] = [];
    const result = generateOneCandidate(spec, baseArgs(dir, { duration: "short", maxResumes: 0, ...overrides }), {
      cueProvider,
      runPipeline: (request, options, deps) => {
        seen.push({ routing: options.routing });
        return stubPipeline()(request, options, { ...deps, spineBuilder: spine, ...(killAfterSpine ? { deepenBuilder: new KilledAfterSpine() } : {}) });
      }
    });
    return { result, seen };
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-candidates-gv55-"));
    for (const name of Object.values(PIPELINE_FLAG_ENV)) vi.stubEnv(name, undefined);
    for (const name of ["FORAY_GENERATION_MODE", "FORAY_LLM_BASE_URL", "ANTHROPIC_API_KEY", "JEV_API_KEY", "JEV_KEY_FILE", "FORAY_STAGE_SPINE", "FORAY_STAGE_DEEPEN"]) {
      vi.stubEnv(name, undefined);
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* MUTATION: drop `stageAssignments` from the row finishEntry builds. Ran it: red. */
  it("a stub run's row carries stageAssignments: every stage stub, the judge fail-closed", async () => {
    const { result } = run(new CountingSpineBuilder(), false);
    const entry = (await result).entry!;
    expect(entry.outcome).toBe("generated");
    expect(entry.stageAssignments?.spine).toEqual({ impl: "stub", model: "stub" });
    expect(entry.stageAssignments?.writer).toEqual({ impl: "stub", model: "stub" });
    expect(entry.stageAssignments?.judge).toEqual({ impl: "none", model: "none" });
    expect(entry.stageAssignments?.["spine-alt"]).toBeUndefined();
  });

  /* MUTATION: resolve the driver's routing from process.env alone (drop
     withStageProviders): the --stage-provider override never reaches the
     pipeline or the row. Ran it: red. */
  it("--stage-provider reaches the pipeline's routing and the row's stageAssignments", async () => {
    vi.stubEnv("FORAY_LLM_BASE_URL", LLM);
    const { result, seen } = run(new CountingSpineBuilder(), false, { stageProviders: { spine: "local:second", deepen: "local:spark" } });
    const entry = (await result).entry!;
    expect(entry.outcome).toBe("generated");
    const routing = seen[0]!.routing as ReturnType<typeof resolveRouting>;
    expect(routing.mode).toBe("local");
    expect(routing.routes.spine).toMatchObject({ provider: "local", lane: "second" });
    expect(routing.routes.deepen).toMatchObject({ provider: "local", lane: "spark" });
    expect(entry.stageAssignments?.spine).toMatchObject({ impl: "local", machine: "second" });
    expect(entry.stageAssignments?.deepen).toMatchObject({ impl: "local", machine: "spark" });
    expect(entry.stageAssignments?.research).toEqual({ impl: "none", model: "none" });
  });

  /* MUTATION: hash `checkpointVariant(flags)` at runPipeline.ts's session
     (no routing), or drop `routing` from the options the driver passes (the
     session then resolves process.env without the --stage-provider
     override). Each: the session's fingerprint no longer equals the file's.
     Ran both: red. */
  it("the store and session fingerprints are equal under a local routing, and differ between routings", async () => {
    vi.stubEnv("FORAY_LLM_BASE_URL", LLM);
    const open = vi.spyOn(CheckpointSession, "open");
    const prints = new Set<string>();
    for (const stageProviders of [undefined, { spine: "local:second" } as const]) {
      fs.rmSync(checkpointFile(), { force: true });
      open.mockClear();
      const { result } = run(new CountingSpineBuilder(), true, stageProviders ? { stageProviders } : {});
      expect((await result).entry?.outcome).toBe("error");
      const sessionFingerprint = open.mock.calls[0]![2];
      expect(readCheckpoint().fingerprint).toBe(sessionFingerprint);
      prints.add(sessionFingerprint);
    }
    expect(prints.size).toBe(2);
    const classic = checkpointFingerprint({ prompt: spec.prompt, duration: "short" });
    expect(prints.has(classic)).toBe(false);
    const localDefault = checkpointRunVariant(readPipelineFlags({}), resolveRouting({ FORAY_LLM_BASE_URL: LLM }));
    expect(prints.has(checkpointFingerprint({ prompt: spec.prompt, duration: "short", variant: localDefault }))).toBe(true);
  });

  /* MUTATION: `routingVariant` returning undefined in local mode (the
     routing never joins the variant). Ran it: red: the local run resumes the
     stub-built spine. */
  it("a local run never resumes a spine banked by a stub run, and resumes its own", async () => {
    const stubSpine = new CountingSpineBuilder();
    expect((await run(stubSpine, true).result).entry?.outcome).toBe("error");
    expect(stubSpine.calls).toBe(1);
    expect(readCheckpoint().fingerprint).toBe(checkpointFingerprint({ prompt: spec.prompt, duration: "short" }));

    vi.stubEnv("FORAY_LLM_BASE_URL", LLM);
    const localSpine = new CountingSpineBuilder();
    expect((await run(localSpine, true).result).entry?.outcome).toBe("error");
    expect(localSpine.calls).toBe(1);

    const resumed = new CountingSpineBuilder();
    expect((await run(resumed, false).result).entry?.outcome).toBe("generated");
    expect(resumed.calls).toBe(0);
  });

  /* MUTATION: drop `generationMode` or `routing` from batchReportDocument. Ran it: red. */
  it("report.json carries routing and generationMode, with no credential", () => {
    const routing = resolveRouting({ FORAY_LLM_BASE_URL: "http://user:secret@litellm.test:4000/v1", FORAY_STAGE_SPINE: "local:second" });
    const doc = batchReportDocument({
      generatedAt: "2026-10-13T00:00:00.000Z",
      maxResumes: 3,
      continueOnRefusedPartial: false,
      resumes: 0,
      aborts: 0,
      notify: null,
      notification: null,
      corpus: null,
      prompts: { file: "p.json", sha256: "0".repeat(64), count: 1 },
      generationMode: routing.mode,
      routing: routingSummary(routing),
      anthropicCalls: 0,
      entries: []
    });
    const written = JSON.parse(JSON.stringify(doc)) as { generationMode: string; routing: { mode: string; stages: Record<string, string>; overridden: string[] } };
    expect(written.generationMode).toBe("local");
    expect(written.routing.mode).toBe("local");
    expect(written.routing.stages.spine).toMatch(/^local:second /);
    expect(written.routing.overridden).toEqual(["spine"]);
    expect(JSON.stringify(doc)).not.toContain("secret");
  });
});

describe("GV-39 — report.json names the prompt set and the corpus snapshot it ran against", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "gv39-report-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** A prompts file with CRLF line ends and odd spacing: its bytes, not its
   * parsed prompts, are what the hash must cover. */
  function writePrompts(): { file: string; bytes: Buffer } {
    const file = path.join(dir, "golden-v1.prompts.json");
    const bytes = Buffer.from('[\r\n  "germ theory, start to finish",\r\n  { "prompt": "banded iron", "id": "gold-02" }\r\n]\r\n', "utf8");
    fs.writeFileSync(file, bytes);
    return { file, bytes };
  }

  /** A tmpdir corpus with one show, two digest rows and one body on disk. */
  function corpusOnDisk() {
    const root = path.join(dir, "normalized");
    const showDir = path.join(root, "tpwky-6eb31515b0");
    fs.mkdirSync(showDir, { recursive: true });
    const row = (guid: string, sha256: string) => ({ show_id: "tpwky", show_title: "TPWKY", guid, title: guid, cues: 1, sha256, bytes: 64 });
    const archive = [row("ep-1", "1".repeat(64)), row("ep-2", "2".repeat(64))];
    fs.writeFileSync(
      path.join(showDir, `${corpusSafeKey("ep-1")}.json`),
      JSON.stringify({ show_id: "tpwky", guid: "ep-1", cues: [{ text: "miasma and Semmelweis", start_sec: 0, end_sec: 4 }] }),
      "utf8"
    );
    const provider = new FileTranscriptCueProvider(root);
    const hasBody = (entry: { show_id: string }) => provider.bodyStat(entry as (typeof archive)[number]) !== null;
    return { root, archive, hasBody };
  }

  /** What `main` hands `writeReport`, written and read back as the CLI does. */
  function writtenReport(promptsFile: string, corpus: ReturnType<typeof corpusReport>): Record<string, unknown> {
    const { identity } = readPromptSet(promptsFile);
    const reportPath = path.join(dir, "report.json");
    const doc = batchReportDocument({
      generatedAt: "2026-10-12T00:00:00.000Z",
      maxResumes: 3,
      continueOnRefusedPartial: false,
      resumes: 0,
      aborts: 0,
      notify: null,
      notification: null,
      corpus,
      prompts: identity,
      generationMode: "stub",
      routing: routingSummary(resolveRouting({})),
      anthropicCalls: 0,
      entries: []
    });
    fs.writeFileSync(reportPath, `${JSON.stringify(doc, null, 2)}\n`);
    return JSON.parse(fs.readFileSync(reportPath, "utf8")) as Record<string, unknown>;
  }

  /* MUTATION THAT KILLS THIS: hash the parsed prompts (JSON.stringify(specs))
     or the path instead of the file's bytes, or count the --limit queue. A
     prompt file edited in place keeps its name; only the byte hash says so. */
  it("readPromptSet hashes the very bytes it parsed, names the file and counts its prompts", () => {
    const { file, bytes } = writePrompts();
    const { specs, identity } = readPromptSet(file);
    expect(specs).toEqual([{ prompt: "germ theory, start to finish" }, { prompt: "banded iron", id: "gold-02" }]);
    expect(identity).toEqual({
      file: "golden-v1.prompts.json",
      sha256: createHash("sha256").update(bytes).digest("hex"),
      count: 2
    });
  });

  /* MUTATION THAT KILLS THIS: drop `prompts` from batchReportDocument, or drop
     the fingerprint from corpusReport. Either makes the golden-set snapshot
     silent about what it was taken against. */
  it("a non-dry report carries prompts.sha256 matching the file and corpus.fingerprint when bodies exist", () => {
    const { file, bytes } = writePrompts();
    const { root, archive, hasBody } = corpusOnDisk();
    const coverage = corpusCoverage({ archive, hasBody, normalizedRoot: root });
    const fingerprint = corpusFingerprint({ archive, hasBody, indexVersion: TRANSCRIPT_TEXT_INDEX_VERSION });
    const report = writtenReport(file, corpusReport(coverage, fingerprint));

    expect(report.dry_run).toBe(false);
    expect(report.prompts).toEqual({ file: "golden-v1.prompts.json", sha256: createHash("sha256").update(bytes).digest("hex"), count: 2 });
    const corpus = report.corpus as { showsOnDisk: number; fingerprint: { sha256: string; rows: number; indexVersion: number } };
    expect(corpus.showsOnDisk).toBe(1);
    expect(corpus.fingerprint.rows).toBe(1);
    expect(corpus.fingerprint.indexVersion).toBe(TRANSCRIPT_TEXT_INDEX_VERSION);
    expect(corpus.fingerprint.sha256).toBe(createHash("sha256").update(`tpwky\tep-1\t${"1".repeat(64)}`).digest("hex"));
    /* The existing fields keep their order; the two new ones are additive. */
    expect(Object.keys(report)).toEqual([
      "generated_at",
      "dry_run",
      "max_resumes",
      "continue_on_refused_partial",
      "resumes",
      "aborts",
      "notify",
      "notification",
      "corpus",
      "prompts",
      "generationMode",
      "routing",
      "anthropicCalls",
      "entries"
    ]);
  });

  it("with no corpus directory the report's corpus stays null and prompts are still named", () => {
    const { file } = writePrompts();
    const missing = path.join(dir, "no-such-corpus");
    const coverage = corpusCoverage({ archive: [], hasBody: () => false, normalizedRoot: missing });
    const report = writtenReport(file, corpusReport(coverage, corpusFingerprint({ archive: [], hasBody: () => false, indexVersion: 2 })));
    expect(report.corpus).toBeNull();
    expect((report.prompts as { count: number }).count).toBe(2);
  });
});

describe("GV-44 — --job-dir publishes the job snapshot", () => {
  let dir: string;
  let jobDir: string;
  /* The understander's copy differs from the prompt, so the prompt string
     can only reach a job file if something carries the prompt itself. */
  const PROMPT = "tell me the whole story of grilling and barbecue please";
  class RetitlingUnderstander extends StubPromptUnderstander {
    override async extractIntent(prompt: string, ctx: PromptUnderstandContext): Promise<IntentUnderstanding> {
      const intent = await super.extractIntent(prompt, ctx);
      return { ...intent, subject: "Fire, smoke and the long cook", priorKnowledge: "Knows the word.", disappointment: "Stays on the surface." };
    }
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-candidates-gv44-"));
    jobDir = path.join(dir, "jobs");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** The stub pipeline with the retitling understander; after every hook the
   * driver awaited, the job file as it then stood on disk is recorded. */
  const observed = (seen: JobSnapshot[]): typeof runForayPipeline => (request, options, deps = {}) => {
    const readJob = (): void => {
      const files = fs.existsSync(jobDir) ? fs.readdirSync(jobDir).filter((f) => f.endsWith(".job.json")) : [];
      if (files.length) seen.push(JSON.parse(fs.readFileSync(path.join(jobDir, files[0]!), "utf8")) as JobSnapshot);
    };
    return stubPipeline()(request, options, {
      ...deps,
      understander: new RetitlingUnderstander(),
      onItemReady: async (ev) => {
        await deps.onItemReady?.(ev);
        readJob();
      },
      onActReady: async (c) => {
        await deps.onActReady?.(c);
        readJob();
      }
    });
  };

  it("parses --job-dir, and adds nothing without it", () => {
    /* MUTATION THAT KILLS THIS: always set `jobDir` (e.g. to a default
       directory). Every run would publish a job row. Ran it — red. */
    expect(parseArgs(["--prompts", "p.json", "--job-dir", "data-local/jobs"]).jobDir).toBe("data-local/jobs");
    expect("jobDir" in parseArgs(["--prompts", "p.json"])).toBe(false);
  });

  it("a stub run writes <forayId>.job.json with a strictly increasing seq, ending complete", async () => {
    /* MUTATION THAT KILLS THIS: drop the publish from the onItemReady hook
       (act-level snapshots only). The file seen after the first item event
       does not exist yet, so fewer snapshots than events are seen and the
       first is not the prelude alone. Ran it — red. Also killed: drop the
       closeJob("complete") call in finishEntry (the final status stays
       "running"). Ran it — red. */
    const seen: JobSnapshot[] = [];
    const result = await generateOneCandidate({ prompt: PROMPT }, baseArgs(dir, { jobDir, maxResumes: 0 }), { cueProvider, runPipeline: observed(seen), newJobId: () => "job-test" });
    expect(result.entry?.outcome).toBe("generated");
    const forayId = JSON.parse(fs.readFileSync(result.file!, "utf8")).id as string;
    expect(fs.readdirSync(jobDir)).toEqual([`${forayId}.job.json`]);
    const final = JSON.parse(fs.readFileSync(path.join(jobDir, `${forayId}.job.json`), "utf8")) as JobSnapshot;

    expect(seen.length).toBeGreaterThan(result.entry!.delivery!.items);
    expect(seen[0]!.items).toHaveLength(1);
    const seqs = [...seen.map((s) => s.seq), final.seq];
    for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    expect(final.status).toBe("complete");
    expect(final.closed).toEqual({ outcome: "complete" });
    expect(final.jobId).toBe("job-test");
    expect(final.forayId).toBe(forayId);
    expect(final.items).toHaveLength(final.delivery!.servableThrough);
    expect(final.items.length).toBeGreaterThan(1);
    expect(final.title).toBe(JSON.parse(fs.readFileSync(result.file!, "utf8")).title);
    for (const s of [...seen, final]) expect(JobSnapshotSchema.safeParse(s).success).toBe(true);
  });

  it("the raw prompt is in none of the written job files", async () => {
    /* MUTATION THAT KILLS THIS: publish the snapshot with the request's
       prompt as its title. The schema refuses nothing then (title is a
       string), and the prompt lands in the job file. Ran it — red. */
    const seen: JobSnapshot[] = [];
    await generateOneCandidate({ prompt: PROMPT }, baseArgs(dir, { jobDir, maxResumes: 0 }), { cueProvider, runPipeline: observed(seen) });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.some((s) => s.title !== null)).toBe(true);
    for (const s of seen) expect(JSON.stringify(s)).not.toContain(PROMPT);
    for (const f of fs.readdirSync(jobDir)) expect(fs.readFileSync(path.join(jobDir, f), "utf8")).not.toContain(PROMPT);
  });

  it("a resumed attempt that publishes nothing still closes the job row the earlier process left", async () => {
    /* A resumed process whose acts were all banked fires no hook, so its sink
       holds no snapshot; the row must not read "running" forever. Here the
       pipeline banks its identity and fails before any act.
       MUTATION THAT KILLS THIS: drop the checkpoint fallback in closeJob
       (`[forayId]` alone). lastPartialId is null, close gets no target, and
       the row stays "running". Ran it — red. */
    const forayId = "fire-smoke-and-the-long-cook-abc123";
    const prior = {
      schema: "foray-job/1",
      jobId: "job-earlier",
      forayId,
      authorId: "founder-1",
      lane: "catalogue",
      status: "running",
      seq: 4,
      updatedAt: "2026-10-12T09:00:00.000Z",
      title: "Fire, smoke and the long cook",
      topic: null,
      summary: null,
      acts: [],
      items: [{ type: "narration", id: "prelude", script: "This Foray was generated.", mode: "marker" }],
      itemStates: [{ itemId: "prelude", check: "prelude", audio: "pending" }],
      runtimeSecSoFar: 5,
      delivery: { servableThrough: 1, itemsGenerated: 1, servableThroughAct: -1, pausedAtIndex: null }
    };
    expect(JobSnapshotSchema.safeParse(prior).success).toBe(true);
    fs.mkdirSync(jobDir, { recursive: true });
    fs.writeFileSync(path.join(jobDir, `${forayId}.job.json`), `${JSON.stringify(prior)}
`);
    const failing: typeof runForayPipeline = async (_request, options, deps = {}) => {
      await deps.checkpoint!.save(options.checkpointKey!, "identity", { startedAt: "2026-10-12T09:00:00.000Z", forayId, topic: null, topicDecision: null });
      throw new Error("boom");
    };
    const result = await generateOneCandidate({ prompt: PROMPT }, baseArgs(dir, { jobDir, maxResumes: 0 }), { cueProvider, runPipeline: failing, newJobId: () => "job-later" });
    expect(result.entry?.outcome).toBe("error");
    const row = JSON.parse(fs.readFileSync(path.join(jobDir, `${forayId}.job.json`), "utf8")) as JobSnapshot;
    expect(row).toMatchObject({ jobId: "job-earlier", seq: 5, status: "failed", closed: { outcome: "failed", detail: "error" } });
    expect(row.items).toHaveLength(1);
  });

  it("writes nothing under --dry-run", async () => {
    /* MUTATION THAT KILLS THIS: open the sink without the `!args.dryRun`
       guard. The dry run writes a job file. Ran it — red. */
    await generateOneCandidate({ prompt: PROMPT }, baseArgs(dir, { jobDir, dryRun: true, maxResumes: 0 }), { cueProvider, runPipeline: observed([]) });
    expect(fs.existsSync(jobDir)).toBe(false);
  });
});

/* GV-68 (the zero-Anthropic rule): report.json carries anthropicCalls per row
   and at the top, and the batch exits non-zero when any Anthropic request was
   sent without FORAY_ALLOW_ANTHROPIC_LEGACY=1. The pipeline is the stub one,
   injected through main()'s test seam; the "Anthropic request" is a real
   createMessage call on a fake client, so nothing leaves the process. */
describe("GV-68 — anthropicCalls in report.json and the non-zero exit", () => {
  let dir: string;
  let savedExitCode: typeof process.exitCode;

  const writePrompts = (): string => {
    const file = path.join(dir, "prompts.json");
    fs.writeFileSync(file, JSON.stringify(["the history of grilling and barbecue"]), "utf8");
    return file;
  };
  const readReport = () =>
    JSON.parse(fs.readFileSync(path.join(dir, "out", "report.json"), "utf8")) as { anthropicCalls: number; entries: Array<{ anthropicCalls?: number; outcome: string }> };

  /** The stub pipeline without main()'s text index: this checkout has no
   * warmed corpus, and the research-map refusal (#703) is not under test. */
  const stubBatchPipeline: typeof runForayPipeline = (request, options, deps) => stubPipeline()(request, options, { ...deps, textIndex: undefined });

  /** One Anthropic request through createMessage, on a fake client. */
  const sendOneAnthropicRequest = async (): Promise<void> => {
    const fakeClient = {
      messages: { create: async () => ({ content: [{ type: "text", text: "{}" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }) }
    } as unknown as Anthropic;
    await createMessage(fakeClient, { model: "m", max_tokens: 10, messages: [{ role: "user", content: "x" }] }, "planted");
  };

  /** The stub pipeline, after sending one Anthropic request. */
  const pipelineCallingAnthropic: typeof runForayPipeline = async (request, options, deps) => {
    await sendOneAnthropicRequest();
    return stubBatchPipeline(request, options, deps);
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-gv68-"));
    savedExitCode = process.exitCode;
    process.exitCode = undefined;
    for (const name of Object.values(PIPELINE_FLAG_ENV)) vi.stubEnv(name, undefined);
    for (const name of ["FORAY_GENERATION_MODE", "FORAY_LLM_BASE_URL", "ANTHROPIC_API_KEY", "JEV_API_KEY", "JEV_KEY_FILE", "FORAY_ALLOW_ANTHROPIC_LEGACY", "GENERATION_NOTIFY_CMD"]) {
      vi.stubEnv(name, undefined);
    }
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(() => {
    process.exitCode = savedExitCode;
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /* MUTATION: drop `anthropicCalls` from the row finishEntry builds (or from
     batchReportDocument). Ran each: red. */
  it("a clean stub batch writes anthropicCalls 0 at the top and on every row, and exits 0", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await main(["--prompts", writePrompts(), "--out", path.join(dir, "out"), "--duration", "short", "--max-resumes", "0"], { runPipeline: stubBatchPipeline });
    expect(err).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
    const report = readReport();
    expect(report.anthropicCalls).toBe(0);
    expect(report.entries).toHaveLength(1);
    expect(report.entries[0]!.outcome).toBe("generated");
    expect(report.entries[0]!.anthropicCalls).toBe(0);
  });

  /* MUTATION: delete the anthropicRuleViolation check at the end of main()
     (or count from 0 instead of the batch's starting count, so the row is
     right and the top level is not). Ran each: red. */
  it("a batch whose pipeline sent an Anthropic request exits non-zero, after writing anthropicCalls into report.json", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => undefined);
    /* A request this process sent BEFORE the batch is not the batch's. */
    await sendOneAnthropicRequest();
    await main(["--prompts", writePrompts(), "--out", path.join(dir, "out"), "--duration", "short", "--max-resumes", "0"], {
      runPipeline: pipelineCallingAnthropic
    });
    expect(process.exitCode).toBe(1);
    expect(String(err.mock.calls[0]![0])).toMatch(/^ZERO-ANTHROPIC RULE BROKEN: this batch sent 1 Anthropic request/);
    const report = readReport();
    expect(report.anthropicCalls).toBe(1);
    expect(report.entries[0]!.outcome).toBe("generated");
    expect(report.entries[0]!.anthropicCalls).toBe(1);
    /* The legacy opt-in is the only way past the check. */
    expect(anthropicRuleViolation(1, { FORAY_ALLOW_ANTHROPIC_LEGACY: "1" })).toBeNull();
    expect(anthropicRuleViolation(1, { FORAY_ALLOW_ANTHROPIC_LEGACY: "yes" })).toMatch(/FORAY_ALLOW_ANTHROPIC_LEGACY=1/);
    expect(anthropicRuleViolation(0, {})).toBeNull();
  });
});

/* GV-74 (docs/roadmap/generation-v2.md, #1286; from W6-07): --render-spool
   puts narration rendering inside the run. Offline: the spool is a tmpdir
   (no worker runs, so no done record appears unless a test writes one), and
   the fold-back tests use a fake render client that answers at once. */
describe("GV-74 — --render-spool enqueues narration and folds audio into delivery", () => {
  let dir: string;
  let spool: string;
  let jobDir: string;
  const PROMPT = "tell me the whole story of grilling and barbecue please";
  const URL_BASE = "https://narration.example.test/n";
  /* The understander's copy differs from the prompt (as GV-44's test does),
     so the prompt can only reach a job file if something carries it. */
  class RetitlingUnderstander extends StubPromptUnderstander {
    override async extractIntent(prompt: string, ctx: PromptUnderstandContext): Promise<IntentUnderstanding> {
      const intent = await super.extractIntent(prompt, ctx);
      return { ...intent, subject: "Fire, smoke and the long cook", priorKnowledge: "Knows the word.", disappointment: "Stays on the surface." };
    }
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-candidates-gv74-"));
    spool = path.join(dir, "spool");
    jobDir = path.join(dir, "jobs");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Answers every job at once: rendered and uploaded, except the item ids
   * in `failing`. `never` answers nothing (a worker that is not running). */
  class InstantRenderClient implements NarrationRenderClient {
    readonly enqueued: RenderJob[] = [];
    constructor(
      private readonly failing: ReadonlySet<string> = new Set(),
      private readonly never = false
    ) {}
    async enqueue(jobs: RenderJob[]): Promise<void> {
      this.enqueued.push(...jobs);
    }
    async results(): Promise<RenderResult[]> {
      if (this.never) return [];
      return this.enqueued.map((j) =>
        this.failing.has(j.itemId)
          ? { jobId: j.jobId, itemId: j.itemId, status: "failed" as const, renderMs: 50, queuedMs: 0 }
          : { jobId: j.jobId, itemId: j.itemId, status: "rendered" as const, key: `n/${j.jobId}.m4a`, publicUrl: `${URL_BASE}/${j.jobId}.m4a`, audioSec: 5, renderMs: 1000, queuedMs: 250 }
      );
    }
  }

  const readJobs = (): JobSnapshot[] =>
    fs.existsSync(jobDir)
      ? fs
          .readdirSync(jobDir)
          .filter((f) => f.endsWith(".job.json"))
          .map((f) => JSON.parse(fs.readFileSync(path.join(jobDir, f), "utf8")) as JobSnapshot)
      : [];
  /** The stub pipeline; after every item hook the driver awaited, the job
   * row as it then stood is recorded. */
  const observed =
    (seen: JobSnapshot[]): typeof runForayPipeline =>
    (request, options, deps = {}) =>
      stubPipeline()(request, options, {
        ...deps,
        onItemReady: async (ev) => {
          await deps.onItemReady?.(ev);
          seen.push(...readJobs());
        }
      });
  type CandidateFile = { id: string; items: Array<{ type: string; id?: string; script?: string }> };
  const narrationIndices = (c: CandidateFile): number[] => c.items.flatMap((it, i) => (it.type === "narration" ? [i] : []));

  it("parses --render-spool and --audio-policy, adds nothing without them, and refuses a bad policy or a policy alone", () => {
    /* MUTATION THAT KILLS THIS: always set `renderSpool` (or default
       `audioPolicy`) in parseRenderFlags. Every run would render, or a run
       without the flag would carry a policy. Ran it — red. Also killed: drop
       the "--audio-policy needs --render-spool" refusal. Ran it — red. */
    const a = parseArgs(["--prompts", "p.json", "--render-spool", "data-local/spool", "--audio-policy", "await-render"]);
    expect(a.renderSpool).toBe("data-local/spool");
    expect(a.audioPolicy).toBe("await-render");
    const plain = parseArgs(["--prompts", "p.json"]);
    expect("renderSpool" in plain).toBe(false);
    expect("audioPolicy" in plain).toBe(false);
    expect("audioPolicy" in parseArgs(["--prompts", "p.json", "--render-spool", "s"])).toBe(false);
    expect(() => parseArgs(["--prompts", "p.json", "--render-spool", "s", "--audio-policy", "loud"])).toThrow(/--audio-policy: "loud"/);
    expect(() => parseArgs(["--prompts", "p.json", "--audio-policy", "await-render"])).toThrow(/needs --render-spool/);
    expect(() => parseArgs(["--prompts", "p.json", "--render-spool"])).toThrow(/--render-spool needs a value/);
  });

  it("SpoolRenderClient writes foray-render-job/1 files into in/ and reads back only its own done records", async () => {
    /* MUTATION THAT KILLS THIS: in results(), read every file in done/
       instead of this client's job ids. Another run's record is folded into
       this Foray. Ran it — red. Also killed: drop the done/ check in
       enqueue (a finished job is queued again). Ran it — red. */
    const clock = (): Date => new Date("2026-10-13T10:00:00.000Z");
    const client = new SpoolRenderClient(spool, clock);
    const jobs: RenderJob[] = [
      { jobId: "f-abc.i0.0123456789abcdef", forayId: "f-abc", itemId: "prelude", script: "This Foray was generated.", priority: 0 },
      { jobId: "f-abc.i3.0123456789abcdee", forayId: "f-abc", itemId: "act-1-exit", script: "And then the smoke.", priority: 3, lexicon: [{ term: "Kansas", ipa: "kænzəs" }] }
    ];
    await client.enqueue(jobs);
    expect(fs.readdirSync(path.join(spool, "in")).sort()).toEqual(jobs.map((j) => `${j.jobId}.job.json`).sort());
    const doc = JSON.parse(fs.readFileSync(path.join(spool, "in", `${jobs[1]!.jobId}.job.json`), "utf8"));
    expect(doc).toEqual({
      schema: "foray-render-job/1",
      job_id: jobs[1]!.jobId,
      foray_id: "f-abc",
      item_id: "act-1-exit",
      script: "And then the smoke.",
      priority: 3,
      enqueued_at: "2026-10-13T10:00:00.000Z",
      lexicon: [{ term: "Kansas", ipa: "kænzəs" }]
    });
    expect(renderJobDocument(jobs[0]!, clock())).not.toHaveProperty("lexicon");
    expect(await client.results()).toEqual([]);

    /* The worker claims job 0 and finishes it; spool-upload confirms it. */
    fs.mkdirSync(path.join(spool, "done"), { recursive: true });
    fs.unlinkSync(path.join(spool, "in", `${jobs[0]!.jobId}.job.json`));
    fs.writeFileSync(
      path.join(spool, "done", `${jobs[0]!.jobId}.json`),
      JSON.stringify({ job_id: jobs[0]!.jobId, status: "rendered", entry: { key: "n/p.m4a", duration_sec: 3 }, timings: { queued_ms: 5, render_ms: 700, audio_sec: 3 }, public_url: `${URL_BASE}/p.m4a` })
    );
    fs.writeFileSync(path.join(spool, "done", "other-run.i0.ffffffffffffffff.json"), JSON.stringify({ job_id: "other-run.i0.ffffffffffffffff", status: "rendered", entry: { key: "x" }, timings: {} }));
    expect(await client.results()).toEqual([{ jobId: jobs[0]!.jobId, itemId: "prelude", status: "rendered", key: "n/p.m4a", publicUrl: `${URL_BASE}/p.m4a`, audioSec: 3, renderMs: 700, queuedMs: 5 }]);
    await client.enqueue([jobs[0]!]);
    expect(fs.existsSync(path.join(spool, "in", `${jobs[0]!.jobId}.job.json`))).toBe(false);
    expect(fs.readdirSync(path.join(spool, "in")).filter((f) => f.startsWith("."))).toEqual([]);
  });

  it("a stub run with --render-spool queues one job per narration item, priority = item index, no prompt in any job", async () => {
    /* MUTATION THAT KILLS THIS: drop the render.onItemReady call from the
       onItemReady hook. in/ stays empty. Ran it — red. */
    const retitled: typeof runForayPipeline = (request, options, deps = {}) => stubPipeline()(request, options, { ...deps, understander: new RetitlingUnderstander() });
    const result = await generateOneCandidate({ prompt: PROMPT }, baseArgs(dir, { renderSpool: spool, maxResumes: 0 }), { cueProvider, runPipeline: retitled });
    expect(result.entry?.outcome).toBe("generated");
    const candidate = JSON.parse(fs.readFileSync(result.file!, "utf8")) as CandidateFile;
    const docs = fs
      .readdirSync(path.join(spool, "in"))
      .map((f) => JSON.parse(fs.readFileSync(path.join(spool, "in", f), "utf8")) as { priority: number; item_id: string; script: string; foray_id: string });
    docs.sort((x, y) => x.priority - y.priority);
    expect(docs.length).toBeGreaterThan(1);
    expect(docs.map((d) => d.priority)).toEqual(narrationIndices(candidate));
    expect(docs.map((d) => d.item_id)).toEqual(narrationIndices(candidate).map((i) => candidate.items[i]!.id));
    expect(docs.map((d) => d.script)).toEqual(narrationIndices(candidate).map((i) => candidate.items[i]!.script));
    for (const d of docs) expect(d.foray_id).toBe(candidate.id);
    for (const f of fs.readdirSync(path.join(spool, "in"))) expect(fs.readFileSync(path.join(spool, "in", f), "utf8")).not.toContain(PROMPT);
    /* No worker answered: the render block says so, it does not invent numbers. */
    expect(result.entry?.delivery?.render).toEqual({ firstRenderedMs: null, narrationSec: 0, renderWallSec: 0, realtimeFactor: null, failed: 0 });
    /* The candidate itself carries no audio: stamping is GV-71's tool, never the run. */
    expect(JSON.stringify(candidate)).not.toContain("audio_url");
  });

  it("without --job-dir the run still reads the render results once at the end: delivery.render is filled", async () => {
    /* MUTATION THAT KILLS THIS: drop the `else await refreshRender()` branch
       at the end of generateOneCandidate. With no job sink nothing else ever
       reads the results, so delivery.render stays all zeros. Ran it — red. */
    const client = new InstantRenderClient(new Set(["prelude"]));
    const result = await generateOneCandidate({ prompt: PROMPT }, baseArgs(dir, { renderSpool: spool, maxResumes: 0 }), {
      cueProvider,
      runPipeline: stubPipeline(),
      renderClient: client
    });
    expect(result.entry?.outcome).toBe("generated");
    expect(fs.existsSync(jobDir)).toBe(false);
    expect(client.enqueued.length).toBeGreaterThan(1);
    const render = result.entry?.delivery?.render;
    expect(render).toMatchObject({ failed: 1, realtimeFactor: 5, narrationSec: 5 * (client.enqueued.length - 1) });
    expect(render!.narrationSec).toBeGreaterThan(0);
  });

  it("rendered and uploaded lines reach the job row with audio_url, a failed one stays phone-voice, and delivery.render is filled", async () => {
    /* MUTATION THAT KILLS THIS: pass no `audio` to snapshotFrom in
       publishJob. The row's items carry no audio_url and every state reads
       "pending". Ran it — red. */
    const seen: JobSnapshot[] = [];
    const client = new InstantRenderClient(new Set(["prelude"]));
    const result = await generateOneCandidate({ prompt: PROMPT }, baseArgs(dir, { renderSpool: spool, jobDir, maxResumes: 0 }), {
      cueProvider,
      runPipeline: observed(seen),
      renderClient: client,
      newJobId: () => "job-render"
    });
    expect(result.entry?.outcome).toBe("generated");
    const candidate = JSON.parse(fs.readFileSync(result.file!, "utf8")) as CandidateFile;
    const final = JSON.parse(fs.readFileSync(path.join(jobDir, `${candidate.id}.job.json`), "utf8")) as JobSnapshot;
    expect(final.status).toBe("complete");
    expect(JobSnapshotSchema.safeParse(final).success).toBe(true);
    const narr = narrationIndices(candidate);
    expect(narr.length).toBe(client.enqueued.length);
    expect(final.items.length).toBe(candidate.items.length);
    let failedLines = 0;
    final.items.forEach((item, i) => {
      const state = final.itemStates[i]!;
      if (item.type !== "narration") {
        expect(state.audio).toBe("pending");
        return;
      }
      const job = client.enqueued.find((j) => j.itemId === state.itemId)!;
      if (state.itemId === "prelude") {
        failedLines++;
        expect(state.audio).toBe("phone-voice");
        expect(item).not.toHaveProperty("audio_url");
      } else {
        expect(state.audio).toBe("rendered");
        expect((item as { audio_url?: string }).audio_url).toBe(`${URL_BASE}/${job.jobId}.m4a`);
        expect(state.audioKey).toBe(`n/${job.jobId}.m4a`);
      }
    });
    expect(failedLines).toBe(1);
    const okLines = narr.length - failedLines;
    const firstOk = client.enqueued.find((j) => j.itemId !== "prelude")!;
    const readyAt = result.entry!.delivery!.firstItemReadyMs;
    expect(readyAt).not.toBeNull();
    const render = result.entry?.delivery?.render;
    expect(render).toMatchObject({ narrationSec: 5 * okLines, renderWallSec: okLines, realtimeFactor: 5, failed: 1 });
    /* The first rendered line: its item's readyAtMs + 250 ms queued + 1 s render. */
    expect(render?.firstRenderedMs).toBeGreaterThanOrEqual(1250);
    expect(firstOk.priority).toBeGreaterThan(0);
  });

  it("await-render holds narration out of the row until its render answers; phone-voice-first serves it at once", async () => {
    /* MUTATION THAT KILLS THIS: hand snapshotFrom the default policy instead
       of render.policy. await-render then serves the prelude before any
       render answered. Ran it — red. */
    const held: JobSnapshot[] = [];
    await generateOneCandidate({ prompt: PROMPT }, baseArgs(dir, { renderSpool: spool, audioPolicy: "await-render", jobDir, maxResumes: 0 }), {
      cueProvider,
      runPipeline: observed(held),
      renderClient: new InstantRenderClient(new Set(), true)
    });
    expect(held.length).toBeGreaterThan(0);
    for (const s of held) {
      expect(s.items).toEqual([]);
      expect(s.delivery?.pausedAtIndex).toBe(0);
    }

    const out2 = path.join(dir, "second");
    const jobDir2 = path.join(dir, "jobs2");
    const served: JobSnapshot[] = [];
    const observe2: typeof runForayPipeline = (request, options, deps = {}) =>
      stubPipeline()(request, options, {
        ...deps,
        onItemReady: async (ev) => {
          await deps.onItemReady?.(ev);
          for (const f of fs.readdirSync(jobDir2)) served.push(JSON.parse(fs.readFileSync(path.join(jobDir2, f), "utf8")) as JobSnapshot);
        }
      });
    await generateOneCandidate({ prompt: PROMPT }, baseArgs(out2, { renderSpool: path.join(dir, "spool2"), jobDir: jobDir2, maxResumes: 0 }), {
      cueProvider,
      runPipeline: observe2,
      renderClient: new InstantRenderClient(new Set(), true)
    });
    expect(served[0]!.items).toHaveLength(1);
    expect(served[0]!.itemStates[0]).toMatchObject({ itemId: "prelude", audio: "phone-voice" });
  });

  it("writes nothing to the spool under --dry-run", async () => {
    /* MUTATION THAT KILLS THIS: build the tracker without the `!args.dryRun`
       guard. The dry run queues jobs. Ran it — red. */
    await generateOneCandidate({ prompt: PROMPT }, baseArgs(dir, { renderSpool: spool, dryRun: true, maxResumes: 0 }), { cueProvider, runPipeline: stubPipeline() });
    expect(fs.existsSync(spool)).toBe(false);
  });
});

/* GV-81 (generation v2, from W6-17): `--lane on-demand|catalogue`. Given, the
   lane goes onto every report row, the candidate's meta.lane and the job row;
   absent, nothing is written and the job row reads catalogue, as before. */
describe("GV-81 — --lane on the report row, the candidate and the job row", () => {
  let dir: string;
  let jobDir: string;
  const PROMPT = "tell me the whole story of grilling and barbecue please";

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-candidates-gv81-"));
    jobDir = path.join(dir, "jobs");
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const jobRow = (): JobSnapshot => {
    const files = fs.readdirSync(jobDir).filter((f) => f.endsWith(".job.json"));
    expect(files).toHaveLength(1);
    return JSON.parse(fs.readFileSync(path.join(jobDir, files[0]!), "utf8")) as JobSnapshot;
  };

  it("parses --lane, adds nothing without it, and refuses a value that is not a lane", () => {
    /* MUTATION THAT KILLS THIS: default `lane` to "catalogue" in parseArgs.
       Every run would write lane onto its rows and candidates. Ran it — red. */
    expect(parseArgs(["--prompts", "p.json", "--lane", "on-demand"]).lane).toBe("on-demand");
    expect(parseArgs(["--prompts", "p.json", "--lane", "catalogue"]).lane).toBe("catalogue");
    expect("lane" in parseArgs(["--prompts", "p.json"])).toBe(false);
    expect(() => parseArgs(["--prompts", "p.json", "--lane", "ondemand"])).toThrow(/--lane: "ondemand" is not one of/);
    expect(() => parseArgs(["--prompts", "p.json", "--lane"])).toThrow(/--lane needs a value/);
  });

  it("an on-demand run carries lane on the report row, meta.lane on the candidate and lane on the job row", async () => {
    /* MUTATION THAT KILLS THIS: keep the job identity's lane at "catalogue"
       (ignore args.lane). The job row reads catalogue. Ran it — red. Also
       killed: drop the lane from finishEntry (the row has none), and write
       outcome.input unchanged (no meta.lane). Ran both — red. */
    const result = await generateOneCandidate({ prompt: PROMPT }, baseArgs(dir, { lane: "on-demand", jobDir, maxResumes: 0 }), { cueProvider, runPipeline: stubPipeline() });
    expect(result.entry?.outcome).toBe("generated");
    expect(result.entry?.lane).toBe("on-demand");
    const written = JSON.parse(fs.readFileSync(result.file!, "utf8")) as FinalizeForayInput;
    expect(written.meta?.lane).toBe("on-demand");
    expect(Object.keys(written.meta ?? {})).toEqual(["veracity", "lane"]);
    expect(jobRow().lane).toBe("on-demand");
  });

  it("without --lane the row and the candidate carry no lane and the job row reads catalogue", async () => {
    const result = await generateOneCandidate({ prompt: PROMPT }, baseArgs(dir, { jobDir, maxResumes: 0 }), { cueProvider, runPipeline: stubPipeline() });
    expect(result.entry?.outcome).toBe("generated");
    expect(result.entry).not.toHaveProperty("lane");
    const written = JSON.parse(fs.readFileSync(result.file!, "utf8")) as FinalizeForayInput;
    expect(Object.keys(written.meta ?? {})).toEqual(["veracity"]);
    expect(jobRow().lane).toBe("catalogue");
  });

  it("a row that never generated still carries the run's lane", async () => {
    /* The lane is the run's, so a stopped prompt's row names it too. */
    const failing: typeof runForayPipeline = async () => {
      throw new Error("boom");
    };
    const result = await generateOneCandidate({ prompt: PROMPT }, baseArgs(dir, { lane: "on-demand", maxResumes: 0 }), { cueProvider, runPipeline: failing });
    expect(result.entry?.outcome).toBe("error");
    expect(result.entry?.lane).toBe("on-demand");
  });
});
