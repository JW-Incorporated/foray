import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { generateOneCandidate, partialCandidateFilename, candidateFilename, type CliArgs } from "../src/cli/generateForays";
import { runForayPipeline, type RunPipelineOutcome } from "../src/generation/runPipeline";
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
      ...(finalize ? { finalize } : {}),
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
