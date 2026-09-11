import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  generateOneCandidate,
  parseArgs,
  classifyFailure,
  resumeBackoffMs,
  msUntilNextLocalDay,
  runNotifyHook,
  summaryLine,
  partialCandidateFilename,
  DEFAULT_MAX_RESUMES,
  type CliArgs,
  type NotifySummary
} from "../src/cli/generateForays";
import { runForayPipeline, RefusedPartialError, uniqueForayId, type RunPipelineOutcome } from "../src/generation/runPipeline";
import { readExistingForayIds, type FinalizeForayInput, type FinalizeForayResult } from "../src/generation/finalizeForay";
import { FileTranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { BudgetStopError, BudgetExceededError, EpisodeBudgetExceededError } from "../src/cost/budgetGuard";

/**
 * G-30 (docs/curation/foray-to-spec-roadmap.md; latency brief §4 manual
 * steps 9, 10, 24, 25, 26): the driver runs without a person. Four claims,
 * each with the mutation that kills it named beside the assertion:
 *
 *   (a) a transient failure resumes from the checkpoint by itself, with
 *       backoff, and stops at `--max-resumes`;
 *   (b) a refused partial candidate ends the run with a NAMED reason by
 *       default and is carried past with `--continue-on-refused-partial`;
 *   (c) the notification hook is invoked once per outcome with the one-line
 *       summary (outcome, id, minutes, calls) — through the REAL shell;
 *   (d) a duplicate Foray id is suffixed at mint time rather than thrown at
 *       finalize.
 *
 * The resume-loop cases drive a FAKE pipeline, because what is under test is
 * the loop around the pipeline, not the pipeline. The refusal and duplicate-id
 * cases drive the REAL `runForayPipeline` with Stub builders and a fake
 * `finalize` (see `generateForays.test.ts` on why the real checkers cannot
 * load under Vitest on this checkout).
 */

const cueProvider = new FileTranscriptCueProvider();

const OK_VALIDATION = { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] };

const FAKE_FINALIZE = async (input: FinalizeForayInput): Promise<FinalizeForayResult> => ({
  validation: OK_VALIDATION,
  forayRecord: { id: input.id, generated: true },
  timings: []
});

/** A finalize that refuses everything — the fixture the card's "fails the
 * partial gate" case asks for. */
const REFUSING_FINALIZE = async (): Promise<FinalizeForayResult> => ({
  validation: { ...OK_VALIDATION, ok: false, checkForaysErrors: ["fixture: this partial is refused"] },
  timings: []
});

function stubPipeline(
  finalize: typeof FAKE_FINALIZE = FAKE_FINALIZE,
  extra: Partial<Parameters<typeof runForayPipeline>[2] & object> = {}
): typeof runForayPipeline {
  return (request, options, deps = {}) =>
    runForayPipeline(request, options, {
      understander: new StubPromptUnderstander(),
      researcher: new StubExternalResearcher(),
      spineBuilder: new StubSpineBuilder(),
      deepenBuilder: new StubDeepenActBuilder(),
      narrationWriter: new StubNarrationWriterBuilder(),
      narrationVerifier: new StubNarrationVerifierBuilder(),
      continuityBuilder: new StubContinuityBuilder(),
      finalize,
      ...extra,
      ...deps
    });
}

/** The smallest "generated, valid" outcome the driver accepts. */
function generatedOutcome(id = "fake-foray-1"): RunPipelineOutcome {
  return {
    outcome: "generated",
    input: { id, title: "t", topic: "food/grilling-bbq", summary: "s", slots: [], items: [], runtimeSec: 0 },
    result: { validation: OK_VALIDATION, forayRecord: { id }, timings: [] },
    spine: {} as never,
    tapeRelevance: [],
    timings: [],
    ttlA1Ms: null,
    narration: { concurrency: 4, acts: [{ act: 0, startedAt: "2026-09-11T00:00:00.000Z", ms: 1 }] }
  };
}

function baseArgs(out: string, overrides: Partial<CliArgs> = {}): CliArgs {
  return {
    prompts: null,
    out,
    duration: "medium",
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

/** A pipeline that throws `errors` in order, then returns `outcome`. */
function flakyPipeline(errors: unknown[], outcome: RunPipelineOutcome = generatedOutcome()): { fn: typeof runForayPipeline; calls: number } {
  const state = { calls: 0, fn: (async () => outcome) as typeof runForayPipeline };
  state.fn = async () => {
    const i = state.calls++;
    if (i < errors.length) throw errors[i];
    return outcome;
  };
  return state;
}

function recordingSleep(): { sleep: (ms: number) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    waits,
    sleep: async (ms) => {
      waits.push(ms);
    }
  };
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-g30-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("G-30 flags", () => {
  it("--max-resumes defaults to 3, reads a non-negative integer, and ignores junk", () => {
    expect(parseArgs(["--prompts", "p.json"]).maxResumes).toBe(3);
    expect(parseArgs(["--prompts", "p.json", "--max-resumes", "0"]).maxResumes).toBe(0);
    expect(parseArgs(["--prompts", "p.json", "--max-resumes", "7"]).maxResumes).toBe(7);
    for (const bad of ["abc", "-1", ""]) {
      expect(parseArgs(["--prompts", "p.json", "--max-resumes", bad]).maxResumes, bad).toBe(3);
    }
    /* `parseInt` truncation, the same reading `--limit` has always had. */
    expect(parseArgs(["--prompts", "p.json", "--max-resumes", "2.9"]).maxResumes).toBe(2);
  });

  it("--continue-on-refused-partial is off unless given", () => {
    expect(parseArgs(["--prompts", "p.json"]).continueOnRefusedPartial).toBe(false);
    expect(parseArgs(["--prompts", "p.json", "--continue-on-refused-partial"]).continueOnRefusedPartial).toBe(true);
  });

  it("--notify comes from the flag, then GENERATION_NOTIFY_CMD, else null", () => {
    /* MUTATION THAT KILLS THIS: read only the flag, or only the env. */
    expect(parseArgs(["--prompts", "p.json"], {}).notify).toBeNull();
    expect(parseArgs(["--prompts", "p.json"], { GENERATION_NOTIFY_CMD: "  " }).notify).toBeNull();
    expect(parseArgs(["--prompts", "p.json"], { GENERATION_NOTIFY_CMD: "gh issue comment 1 -F -" }).notify).toBe("gh issue comment 1 -F -");
    expect(parseArgs(["--prompts", "p.json", "--notify", "echo hi"], { GENERATION_NOTIFY_CMD: "gh ..." }).notify).toBe("echo hi");
  });
});

describe("classifyFailure — what the driver may resume from on its own", () => {
  it("names the relay's and the SDK's transient shapes", () => {
    expect(classifyFailure(new Error("Request timed out.")).kind).toBe("transient");
    expect(classifyFailure(new Error("Connection error.")).kind).toBe("transient");
    expect(classifyFailure(Object.assign(new Error("500 {\"type\":\"error\"}"), { status: 500 })).kind).toBe("transient");
    expect(classifyFailure(Object.assign(new Error("429"), { status: 429 })).kind).toBe("transient");
    expect(classifyFailure(Object.assign(new Error("overloaded_error"), { status: 529 })).kind).toBe("transient");
    expect(classifyFailure(Object.assign(new Error("fetch failed"), { cause: { code: "ECONNRESET" } })).kind).toBe("transient");
    /* Wrapped one level down, the way §4.4's ActDeepeningError wraps it. */
    const wrapped = new Error("Deepening act 2 failed after 1 retry");
    (wrapped as { cause?: unknown }).cause = new Error("Request timed out.");
    expect(classifyFailure(wrapped).kind).toBe("transient");
  });

  it("does NOT read a number in prose as a server error, and leaves a bug fatal", () => {
    /* MUTATION THAT KILLS THIS: a bare `\b5\d\d\b` in the transient regex. */
    expect(classifyFailure(new Error("beat 523 has no anchor")).kind).toBe("fatal");
    expect(classifyFailure(new Error("Cannot read properties of undefined")).kind).toBe("fatal");
    expect(classifyFailure(Object.assign(new Error("bad request"), { status: 400 })).kind).toBe("fatal");
  });

  it("splits the budget stop by scope: daily is a window, per-Foray is a stop", () => {
    const daily = new BudgetStopError("narrate:1", 9.9, 10, "daily", new BudgetExceededError(1, 9.9, 0.2, 10));
    const perForay = new BudgetStopError("narrate:1", 9.9, 10, "per-foray", new EpisodeBudgetExceededError("s", 9.9, 0.2, 10));
    expect(classifyFailure(daily).kind).toBe("budget-window");
    expect(classifyFailure(perForay).kind).toBe("budget-stop");
    expect(classifyFailure(new RefusedPartialError(0, 3, ["x"], [])).kind).toBe("refused-partial");
  });

  it("backs off 30 s, 60 s, 120 s … capped at 10 min; a budget window waits for the next local day", () => {
    expect([0, 1, 2, 3].map(resumeBackoffMs)).toEqual([30_000, 60_000, 120_000, 240_000]);
    expect(resumeBackoffMs(20)).toBe(600_000);
    const at = new Date(2026, 8, 11, 22, 30, 0, 0); // local 22:30
    expect(msUntilNextLocalDay(at)).toBe(90 * 60_000 + 60_000);
  });
});

describe("(a) the resume loop", () => {
  it("re-runs after a transient error, resumes from the same checkpoint key, and records each resume", async () => {
    const spec = { prompt: "resume me after a relay timeout" };
    const pipeline = flakyPipeline([new Error("Request timed out."), Object.assign(new Error("502"), { status: 502 })]);
    const { sleep, waits } = recordingSleep();
    const seenKeys: (string | undefined)[] = [];
    const runPipeline: typeof runForayPipeline = (req, options, deps) => {
      seenKeys.push(options.checkpointKey);
      return pipeline.fn(req, options, deps);
    };

    const result = await generateOneCandidate(spec, baseArgs(dir), { cueProvider, runPipeline, sleep });

    /* MUTATION THAT KILLS THIS: drop the loop and return the "error" entry on
       the first throw — `pipeline.calls` would be 1 and no file written. */
    expect(pipeline.calls).toBe(3);
    expect(waits).toEqual([30_000, 60_000]);
    expect(new Set(seenKeys).size).toBe(1);
    expect(result.entry?.outcome).toBe("generated");
    expect(result.file && fs.existsSync(result.file)).toBe(true);
    expect(result.entry?.resumes?.map((r) => r.kind)).toEqual(["transient", "transient"]);
    expect(result.entry?.resumes?.[0]?.reason).toMatch(/timed out/);
    expect(result.entry?.resumes?.[1]?.reason).toMatch(/HTTP 502/);
  });

  it("stops at --max-resumes and records a named abort, keeping the checkpoint", async () => {
    const spec = { prompt: "never comes back" };
    const pipeline = flakyPipeline(Array.from({ length: 10 }, () => new Error("Request timed out.")));
    const { sleep, waits } = recordingSleep();

    const result = await generateOneCandidate(spec, baseArgs(dir, { maxResumes: 2 }), { cueProvider, runPipeline: pipeline.fn, sleep });

    /* MUTATION THAT KILLS THIS: `<=` instead of `<` on the cap — four calls,
       three waits. */
    expect(pipeline.calls).toBe(3);
    expect(waits.length).toBe(2);
    expect(result.entry?.outcome).toBe("aborted");
    expect(result.entry?.abort?.reason).toBe("resumes-exhausted");
    expect(result.entry?.resumes?.length).toBe(2);
    expect(result.file).toBeUndefined();
  });

  it("--max-resumes 0 restores the single attempt", async () => {
    const pipeline = flakyPipeline([new Error("Request timed out.")]);
    const { sleep, waits } = recordingSleep();
    const result = await generateOneCandidate({ prompt: "one shot" }, baseArgs(dir, { maxResumes: 0 }), { cueProvider, runPipeline: pipeline.fn, sleep });
    expect(pipeline.calls).toBe(1);
    expect(waits).toEqual([]);
    expect(result.entry?.abort?.reason).toBe("resumes-exhausted");
  });

  it("does not retry a fatal error, and the entry stays `error` as before", async () => {
    const pipeline = flakyPipeline([new Error("Cannot read properties of undefined")]);
    const { sleep } = recordingSleep();
    const result = await generateOneCandidate({ prompt: "a bug" }, baseArgs(dir), { cueProvider, runPipeline: pipeline.fn, sleep });
    /* MUTATION THAT KILLS THIS: treat every error as transient. */
    expect(pipeline.calls).toBe(1);
    expect(result.entry?.outcome).toBe("error");
    expect(result.entry?.resumes).toBeUndefined();
  });

  it("a DAILY budget stop waits for the next local day and resumes; a per-Foray stop aborts (manual step 26)", async () => {
    const daily = new BudgetStopError("narrate:1", 9.9, 10, "daily", new BudgetExceededError(1, 9.9, 0.2, 10));
    const pipeline = flakyPipeline([daily]);
    const { sleep, waits } = recordingSleep();
    const now = (): Date => new Date(2026, 8, 11, 23, 0, 0, 0);

    const result = await generateOneCandidate({ prompt: "window" }, baseArgs(dir), { cueProvider, runPipeline: pipeline.fn, sleep, now });
    expect(pipeline.calls).toBe(2);
    expect(waits).toEqual([60 * 60_000 + 60_000]);
    expect(result.entry?.resumes?.[0]?.kind).toBe("budget-window");
    expect(result.entry?.outcome).toBe("generated");

    const perForay = new BudgetStopError("narrate:1", 9.9, 10, "per-foray", new EpisodeBudgetExceededError("s", 9.9, 0.2, 10));
    const stopping = flakyPipeline([perForay]);
    const second = recordingSleep();
    const stopped = await generateOneCandidate({ prompt: "capped" }, baseArgs(dir), { cueProvider, runPipeline: stopping.fn, sleep: second.sleep });
    /* MUTATION THAT KILLS THIS: treat every BudgetStopError as a window. */
    expect(stopping.calls).toBe(1);
    expect(second.waits).toEqual([]);
    expect(stopped.entry?.abort?.reason).toBe("budget-stop");
    expect(stopped.entry?.detail).toMatch(/Raise the cap/);
  });
});

describe("(b) a refused partial candidate", () => {
  it("aborts the run with a named reason by default, after act 1's partial is on disk", async () => {
    const spec = { prompt: "the history of grilling and barbecue" };
    const writes: number[] = [];
    const result = await generateOneCandidate(spec, baseArgs(dir), {
      cueProvider,
      runPipeline: stubPipeline(REFUSING_FINALIZE),
      onPartialWrite: (candidate) => writes.push(candidate.acts.filter((a) => a.status === "ready").length)
    });

    /* MUTATION THAT KILLS THIS: never throw in runPipeline's onActReady
       wrapper — every act would be written and the outcome would be
       "generated"/INVALID instead of an abort at act 1. */
    expect(writes).toEqual([1]);
    expect(result.entry?.outcome).toBe("aborted");
    expect(result.entry?.abort?.reason).toBe("refused-partial");
    expect(result.entry?.detail).toMatch(/ABORTED \(refused-partial\)/);
    expect(result.entry?.detail).toMatch(/act 1 of \d+ failed check-forays/);
    expect(result.entry?.detail).toMatch(/fixture: this partial is refused/);
    expect(result.entry?.refusedPartials).toEqual([0]);
    /* The refused partial and the checkpoint are kept for diagnosis. */
    expect(fs.existsSync(path.join(dir, partialCandidateFilename(spec.prompt)))).toBe(true);
    expect(fs.readdirSync(dir).some((f) => f.endsWith(".checkpoint.json"))).toBe(true);
  });

  it("continues past it under --continue-on-refused-partial, and the report says so", async () => {
    const spec = { prompt: "the history of grilling and barbecue" };
    const writes: number[] = [];
    const result = await generateOneCandidate(spec, baseArgs(dir, { continueOnRefusedPartial: true }), {
      cueProvider,
      runPipeline: stubPipeline(REFUSING_FINALIZE),
      onPartialWrite: (candidate) => writes.push(candidate.acts.filter((a) => a.status === "ready").length)
    });

    /* MUTATION THAT KILLS THIS: ignore the flag and always pass "abort". */
    expect(writes.length).toBeGreaterThan(1);
    expect(result.entry?.outcome).toBe("generated");
    expect(result.entry?.detail).toMatch(/^INVALID /);
    expect(result.entry?.refusedPartials).toEqual(writes.map((_, i) => i));
  });
});

describe("(c) the notification hook", () => {
  it("is invoked once per prompt with the summary (outcome, id, minutes, calls), and recorded in the entry", async () => {
    const summaries: NotifySummary[] = [];
    const notify = async (s: NotifySummary) => {
      summaries.push(s);
      return { command: "fake", summary: summaryLine(s), exitCode: 0 };
    };
    const result = await generateOneCandidate({ prompt: "notify me" }, baseArgs(dir, { notify: "fake" }), {
      cueProvider,
      runPipeline: flakyPipeline([], generatedOutcome("notified-1")).fn,
      notify
    });

    /* MUTATION THAT KILLS THIS: fire the hook only from main()'s batch end. */
    expect(summaries.length).toBe(1);
    expect(summaries[0]).toMatchObject({ outcome: "built", id: "notified-1", calls: 0 });
    expect(summaries[0]!.minutes).toBeGreaterThanOrEqual(0);
    expect(summaryLine(summaries[0]!)).toMatch(/^foray-generation built id=notified-1 minutes=\d+\.\d calls=0 — OK notified-1/);
    expect(result.entry?.notification).toMatchObject({ command: "fake", exitCode: 0 });
    expect(result.entry?.calls).toBe(0);
  });

  it("fires for an abort too, naming the reason", async () => {
    const summaries: NotifySummary[] = [];
    await generateOneCandidate({ prompt: "abort me" }, baseArgs(dir, { maxResumes: 0, notify: "fake" }), {
      cueProvider,
      runPipeline: flakyPipeline([new Error("Request timed out.")]).fn,
      notify: async (s) => {
        summaries.push(s);
        return { command: "fake", summary: summaryLine(s), exitCode: 0 };
      }
    });
    expect(summaries.map((s) => s.outcome)).toEqual(["aborted:resumes-exhausted"]);
  });

  it("runs the REAL shell hook with the line on stdin and in the environment, and never throws", async () => {
    const outFile = path.join(dir, "notified.txt");
    const stdinFile = path.join(dir, "stdin.txt");
    /* Portable across cmd.exe and sh: node reads its own env and stdin. */
    const command =
      `node -e "const fs=require('fs');fs.writeFileSync(process.env.G30_OUT,process.env.FORAY_NOTIFY_SUMMARY);` +
      `fs.writeFileSync(process.env.G30_STDIN,fs.readFileSync(0,'utf8'))"`;
    const summary: NotifySummary = { outcome: "built", id: "real-hook-1", minutes: 12.34, calls: 51, detail: "OK real-hook-1 (51 items, 2421s)" };

    const result = await runNotifyHook(command, summary, { env: { ...process.env, G30_OUT: outFile, G30_STDIN: stdinFile } });

    expect(result.exitCode).toBe(0);
    expect(result.error).toBeUndefined();
    expect(fs.readFileSync(outFile, "utf8")).toBe("foray-generation built id=real-hook-1 minutes=12.3 calls=51 — OK real-hook-1 (51 items, 2421s)");
    expect(fs.readFileSync(stdinFile, "utf8").trim()).toBe(result.summary);

    /* A failing hook is a recorded result, not an exception. */
    const failed = await runNotifyHook(`node -e "process.exit(3)"`, summary);
    expect(failed.exitCode).toBe(3);
    /* Two real node processes through the shell: under a full-suite load on
       Windows that alone can pass the 10 s default. */
  }, 60_000);
});

describe("(d) a duplicate Foray id is suffixed, not thrown (manual step 25)", () => {
  it("uniqueForayId walks -2, -3, … past every taken id", () => {
    expect(uniqueForayId("a-1", new Set())).toBe("a-1");
    expect(uniqueForayId("a-1", new Set(["a-1"]))).toBe("a-1-2");
    /* MUTATION THAT KILLS THIS: return `${id}-2` without re-checking. */
    expect(uniqueForayId("a-1", new Set(["a-1", "a-1-2"]))).toBe("a-1-3");
  });

  it("readExistingForayIds reads data/forays.json under root, and is empty without one", () => {
    fs.mkdirSync(path.join(dir, "data"));
    fs.writeFileSync(path.join(dir, "data", "forays.json"), JSON.stringify({ forays: [{ id: "x-1" }, { id: "y-2" }, { title: "no id" }] }));
    expect([...readExistingForayIds(dir)].sort()).toEqual(["x-1", "y-2"]);
    expect(readExistingForayIds(path.join(dir, "nowhere")).size).toBe(0);
  });

  it("the pipeline mints a suffixed id when its own id is already taken, before the first partial is validated", async () => {
    const spec = { prompt: "the history of grilling and barbecue" };
    const now = (): Date => new Date("2026-09-05T12:00:00.000Z");
    const runWith = (taken: Set<string>): typeof runForayPipeline => (req, options, deps) =>
      stubPipeline(FAKE_FINALIZE, { existingForayIds: () => taken })(req, { ...options, now }, deps);

    const first = await generateOneCandidate(spec, baseArgs(dir), { cueProvider, runPipeline: runWith(new Set()) });
    const firstId = JSON.parse(fs.readFileSync(first.file!, "utf8")).id as string;
    fs.rmSync(first.file!);

    const finalizeIds: string[] = [];
    const seeingFinalize = async (input: FinalizeForayInput): Promise<FinalizeForayResult> => {
      finalizeIds.push(input.id);
      return FAKE_FINALIZE(input);
    };
    const second = await generateOneCandidate(spec, baseArgs(dir), {
      cueProvider,
      runPipeline: (req, options, deps) => stubPipeline(seeingFinalize, { existingForayIds: () => new Set([firstId]) })(req, { ...options, now }, deps)
    });
    const secondId = JSON.parse(fs.readFileSync(second.file!, "utf8")).id as string;

    /* MUTATION THAT KILLS THIS: apply the suffix only at the whole-Foray
       finalize — the partial's finalize would then still see the taken id. */
    expect(secondId).toBe(`${firstId}-2`);
    expect(finalizeIds.length).toBeGreaterThan(1);
    expect(new Set(finalizeIds)).toEqual(new Set([secondId]));
  });
});
