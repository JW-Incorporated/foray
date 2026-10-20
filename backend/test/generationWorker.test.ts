import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  ALREADY_BUILT_DETAIL,
  DEFAULT_WORKER_OUT,
  IDLE_BACKOFF,
  SupabaseWorkerRpc,
  WORKER_ERROR_DETAIL,
  WORKER_HEARTBEAT_MS,
  parseWorkerArgs,
  redactPrompt,
  runWorker,
  workerStartRefusal,
  type ClaimedJob,
  type WorkerClock,
  type WorkerFetch,
  type WorkerOptions,
  type WorkerRpc,
} from "../src/cli/generationWorker";
import {
  candidateFilename,
  generateOneCandidate,
  type CliArgs,
} from "../src/cli/generateForays";
import { SupabaseJobSink, type JobSinkFetch } from "../src/cli/supabaseJobSink";
import { runForayPipeline } from "../src/generation/runPipeline";
import { FileTranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type {
  FinalizeForayInput,
  FinalizeForayResult,
} from "../src/generation/finalizeForay";
import type { PromptUnderstandContext } from "../src/generation/PromptUnderstander";
import type { IntentUnderstanding } from "../src/types/generation";
import {
  JobSnapshotSchema,
  type GenerationJobSink,
  type JobCloseOutcome,
  type JobSnapshot,
} from "../src/generation/jobSink";
import type {
  NarrationRenderClient,
  RenderJob,
  RenderResult,
} from "../src/generation/narrationRender";

/**
 * GV-105 (docs/roadmap/generation-v2.md, #1286; from W6-19): the Spark
 * generation worker, offline. A fake RPC client (claim_generation_job and the
 * heartbeat), an in-memory job sink or a SupabaseJobSink over a fake
 * PostgREST, a fake render client and a fake clock; the pipeline is the REAL
 * runForayPipeline with Stub builders bound explicitly (generateForays.test.ts's
 * stubPipeline), driven through the real generateOneCandidate. No network, no
 * key, no model. Each test names the mutation it kills; each was run against
 * the source and went red.
 */

const cueProvider = new FileTranscriptCueProvider();
const PROMPT =
  "tell me the whole story of grilling and barbecue please, from the first fires";
const AUTHOR = "6f1d2c3b-4a59-4e6f-8a7b-9c0d1e2f3a4b";
const JOB_A = "0b9c7a52-5c4e-4c11-9a1e-7f0d2b6c8e41";
const JOB_B = "1c8d6b41-4d3f-4b22-8b2f-6e1c3a5d7f52";

/** The understander's copy differs from the prompt, so the prompt can reach a
 * snapshot, a file or a log line only if something carries the prompt itself
 * (GV-44's test does the same). */
class RetitlingUnderstander extends StubPromptUnderstander {
  override async extractIntent(
    prompt: string,
    ctx: PromptUnderstandContext,
  ): Promise<IntentUnderstanding> {
    const intent = await super.extractIntent(prompt, ctx);
    return {
      ...intent,
      subject: "Fire, smoke and the long cook",
      priorKnowledge: "Knows the word.",
      disappointment: "Stays on the surface.",
    };
  }
}

const FAKE_FINALIZE = async (
  input: FinalizeForayInput,
): Promise<FinalizeForayResult> => ({
  validation: {
    ok: true,
    checkForaysErrors: [],
    checkForaysWarnings: [],
    checkNarrationErrors: [],
    checkNarrationWarnings: [],
  },
  forayRecord: { id: input.id, generated: true },
  timings: [],
});

/** The real pipeline on Stub builders; every call is counted. */
function stubPipeline(
  calls: {
    request: Parameters<typeof runForayPipeline>[0];
    options: Parameters<typeof runForayPipeline>[1];
  }[] = [],
): typeof runForayPipeline {
  return (request, options, deps = {}) => {
    calls.push({ request, options });
    return runForayPipeline(request, options, {
      understander: new RetitlingUnderstander(),
      researcher: new StubExternalResearcher(),
      spineBuilder: new StubSpineBuilder(),
      deepenBuilder: new StubDeepenActBuilder(),
      narrationWriter: new StubNarrationWriterBuilder(),
      narrationVerifier: new StubNarrationVerifierBuilder(),
      continuityBuilder: new StubContinuityBuilder(),
      finalize: FAKE_FINALIZE,
      ...deps,
    });
  };
}

interface SinkLog {
  published: JobSnapshot[];
  closed: { outcome: JobCloseOutcome; detail?: string }[];
}

class MemorySink implements GenerationJobSink {
  readonly log: SinkLog = { published: [], closed: [] };
  async publish(s: JobSnapshot): Promise<void> {
    this.log.published.push(JSON.parse(JSON.stringify(s)) as JobSnapshot);
  }
  async close(outcome: JobCloseOutcome, detail?: string): Promise<void> {
    this.log.closed.push({
      outcome,
      ...(detail !== undefined ? { detail } : {}),
    });
  }
}

/** claim_generation_job over an in-memory queue: a claimed job leaves the
 * queue, exactly as the SQL moves it out of 'queued'. */
function fakeRpc(
  queue: ClaimedJob[],
): WorkerRpc & {
  claims: number;
  heartbeats: { jobId: string; worker: string }[];
} {
  const rpc = {
    claims: 0,
    heartbeats: [] as { jobId: string; worker: string }[],
    async claim(): Promise<ClaimedJob | null> {
      rpc.claims += 1;
      return queue.shift() ?? null;
    },
    async heartbeat(jobId: string, worker: string): Promise<void> {
      rpc.heartbeats.push({ jobId, worker });
    },
  };
  return rpc;
}

function fakeClock(): WorkerClock & {
  sleeps: number[];
  timers: { ms: number; fn: () => void; cancelled: boolean }[];
} {
  let t = Date.parse("2026-10-20T09:00:00.000Z");
  const clock = {
    sleeps: [] as number[],
    timers: [] as { ms: number; fn: () => void; cancelled: boolean }[],
    now: () => new Date((t += 1000)),
    sleep: async (ms: number) => {
      clock.sleeps.push(ms);
    },
    every: (ms: number, fn: () => void) => {
      const timer = { ms, fn, cancelled: false };
      clock.timers.push(timer);
      return () => {
        timer.cancelled = true;
      };
    },
  };
  return clock;
}

class RecordingRenderClient implements NarrationRenderClient {
  readonly jobs: RenderJob[] = [];
  async enqueue(jobs: RenderJob[]): Promise<void> {
    this.jobs.push(...jobs);
  }
  async results(): Promise<RenderResult[]> {
    return [];
  }
}

const job = (id: string, extra: Partial<ClaimedJob> = {}): ClaimedJob => ({
  id,
  authorId: AUTHOR,
  tier: "short",
  lane: "on-demand",
  prompt: PROMPT,
  ...extra,
});

let dir: string;
let lines: string[];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-worker-gv105-"));
  lines = [];
  for (const m of ["log", "info", "warn", "error"] as const) {
    vi.spyOn(console, m).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(String).join(" "));
    });
  }
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});

function options(extra: Partial<WorkerOptions> = {}): WorkerOptions {
  return { worker: "spark-test", out: dir, maxResumes: 0, env: {}, ...extra };
}

function allFiles(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs
    .readdirSync(root, { withFileTypes: true })
    .flatMap((e) =>
      e.isDirectory()
        ? allFiles(path.join(root, e.name))
        : [path.join(root, e.name)],
    );
}

describe("GV-105 — the worker loop", () => {
  it("claims a queued job once, runs the pipeline with the job sink and render client, publishes in seq order and closes complete", async () => {
    /* MUTATION THAT KILLS THIS: drop `jobSink: sink` from the deps runJob
       hands generateOneCandidate (nothing is published, the row is never
       closed). Ran it — red. Also killed: drop `stopHeartbeat()` in the
       finally (the timer stays live). Ran it — red. */
    const rpc = fakeRpc([job(JOB_A)]);
    const clock = fakeClock();
    const sink = new MemorySink();
    const render = new RecordingRenderClient();
    const calls: {
      request: { prompt: string; duration: string };
      options: { userId?: string };
    }[] = [];
    const stats = await runWorker(
      options({
        renderSpool: path.join(dir, "spool"),
        stop: () => rpc.claims >= 3,
      }),
      {
        rpc,
        clock,
        sinkFor: (id) => {
          expect(id).toBe(JOB_A);
          return sink;
        },
        sources: { cueProvider },
        runPipeline: stubPipeline(calls as never),
        renderClientFor: () => render,
      },
    );

    expect(stats).toMatchObject({
      claimed: 1,
      complete: 1,
      failed: 0,
      refused: null,
    });
    expect(rpc.claims).toBe(3);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.request.duration).toBe("short");
    expect(calls[0]!.options.userId).toBe(AUTHOR);

    const seqs = sink.log.published.map((s) => s.seq);
    expect(seqs.length).toBeGreaterThan(2);
    for (let i = 1; i < seqs.length; i++)
      expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
    for (const s of sink.log.published) {
      expect(JobSnapshotSchema.safeParse(s).success).toBe(true);
      expect(s.jobId).toBe(JOB_A);
      expect(s.lane).toBe("on-demand");
      expect(s.authorId).toBe(AUTHOR);
    }
    expect(sink.log.closed).toEqual([{ outcome: "complete" }]);
    /* Phone voice first: every narration line went to the render client,
       and the snapshot says the phone speaks what has no file yet. */
    expect(render.jobs.length).toBeGreaterThan(0);
    const last = sink.log.published.at(-1)!;
    const narrationIds = new Set(
      last.items
        .filter((it) => it.type === "narration")
        .map((it) => (it as { id: string }).id),
    );
    expect(narrationIds.size).toBeGreaterThan(0);
    for (const st of last.itemStates)
      if (narrationIds.has(st.itemId)) expect(st.audio).toBe("phone-voice");

    /* One heartbeat timer at 10 s for the job, cancelled when it ended;
       firing it touches this job's row. */
    expect(clock.timers).toHaveLength(1);
    expect(clock.timers[0]!.ms).toBe(WORKER_HEARTBEAT_MS);
    expect(clock.timers[0]!.cancelled).toBe(true);
    clock.timers[0]!.fn();
    await Promise.resolve();
    expect(rpc.heartbeats).toEqual([{ jobId: JOB_A, worker: "spark-test" }]);
    /* The candidate is keyed by the job, under --out. */
    expect(fs.existsSync(path.join(dir, `job-${JOB_A}.json`))).toBe(true);
  });

  it("a pipeline that throws closes its job failed and the loop goes on to the next job", async () => {
    /* MUTATION THAT KILLS THIS: end the loop after a failed job (`break`
       when end !== "complete"). The second job is never claimed. Ran it —
       red. */
    const rpc = fakeRpc([
      job(JOB_A, {
        prompt: "the first prompt, which the pipeline cannot take",
      }),
      job(JOB_B),
    ]);
    const sinks = new Map<string, MemorySink>();
    const stub = stubPipeline();
    const stats = await runWorker(options({ stop: () => rpc.claims >= 3 }), {
      rpc,
      clock: fakeClock(),
      sinkFor: (id) => {
        const s = new MemorySink();
        sinks.set(id, s);
        return s;
      },
      sources: { cueProvider },
      runPipeline: (request, opts, deps) => {
        if (request.prompt.startsWith("the first prompt"))
          throw new Error("boom");
        return stub(request, opts, deps);
      },
    });
    expect(stats).toMatchObject({ claimed: 2, complete: 1, failed: 1 });
    expect(sinks.get(JOB_A)!.log.closed).toEqual([
      { outcome: "failed", detail: "error" },
    ]);
    expect(sinks.get(JOB_B)!.log.closed).toEqual([{ outcome: "complete" }]);
  });

  it("an exception that escapes the driver closes the job failed with a short code, and the loop goes on", async () => {
    /* MUTATION THAT KILLS THIS: drop the closeFailed(WORKER_ERROR_DETAIL) in
       runJob's catch. The row would read "claimed" forever. Ran it — red. */
    const rpc = fakeRpc([job(JOB_A), job(JOB_B)]);
    const sinks = new Map<string, MemorySink>();
    let n = 0;
    const stats = await runWorker(options({ stop: () => rpc.claims >= 3 }), {
      rpc,
      clock: fakeClock(),
      sinkFor: (id) => {
        const s = new MemorySink();
        sinks.set(id, s);
        return s;
      },
      sources: { cueProvider },
      generate: async () => {
        n += 1;
        if (n === 1) throw new Error(`the driver fell over on "${PROMPT}"`);
        return { skipped: true, file: "x" };
      },
    });
    expect(stats).toMatchObject({ claimed: 2, complete: 0, failed: 2 });
    expect(sinks.get(JOB_A)!.log.closed).toEqual([
      { outcome: "failed", detail: WORKER_ERROR_DETAIL },
    ]);
    /* A job whose candidate already exists is closed too, never left open. */
    expect(sinks.get(JOB_B)!.log.closed).toEqual([
      { outcome: "failed", detail: ALREADY_BUILT_DETAIL },
    ]);
    for (const line of lines) expect(line).not.toContain(PROMPT);
  });

  it("a job with no prompt, an unknown tier or an unknown lane is closed failed without running", async () => {
    /* MUTATION THAT KILLS THIS: drop the tier check (the run would start
       with duration "epic"). Ran it — red. */
    const rpc = fakeRpc([
      job(JOB_A, { tier: "epic" }),
      job(JOB_B, { prompt: null }),
    ]);
    const sinks = new Map<string, MemorySink>();
    let ran = 0;
    await runWorker(options({ stop: () => rpc.claims >= 3 }), {
      rpc,
      clock: fakeClock(),
      sinkFor: (id) => {
        const s = new MemorySink();
        sinks.set(id, s);
        return s;
      },
      sources: { cueProvider },
      generate: async () => {
        ran += 1;
        return { skipped: true, file: "x" };
      },
    });
    expect(ran).toBe(0);
    expect(sinks.get(JOB_A)!.log.closed).toEqual([
      { outcome: "failed", detail: "bad-job" },
    ]);
    expect(sinks.get(JOB_B)!.log.closed).toEqual([
      { outcome: "failed", detail: "bad-job" },
    ]);
  });

  it("an empty queue backs off, doubling to the cap, and never claims twice without a wait", async () => {
    /* MUTATION THAT KILLS THIS: drop the `await clock.sleep(idleMs)` (a busy
       loop: six claims, no wait). Ran it — red. Also killed: never double
       the wait. Ran it — red. */
    const rpc = fakeRpc([]);
    const clock = fakeClock();
    const stats = await runWorker(options({ stop: () => rpc.claims >= 6 }), {
      rpc,
      clock,
      sinkFor: () => new MemorySink(),
      sources: { cueProvider },
    });
    expect(rpc.claims).toBe(6);
    expect(clock.sleeps).toEqual([2_000, 4_000, 8_000, 16_000, 30_000, 30_000]);
    expect(clock.sleeps[0]).toBe(IDLE_BACKOFF.minMs);
    expect(stats.idleWaits).toBe(6);
  });

  it("the wait resets after a job, and --once ends at the first empty queue", async () => {
    /* MUTATION THAT KILLS THIS: keep the doubled wait across a claimed job
       (drop `idleMs = 0`). Ran it — red. */
    const queue: ClaimedJob[] = [];
    const rpc = fakeRpc(queue);
    const clock = fakeClock();
    let n = 0;
    const generate = async () =>
      ({
        skipped: false,
        entry: {
          prompt: "",
          outcome: "generated",
          detail: "OK",
          ms: 0,
          file: "f",
        },
      }) as never;
    const realClaim = rpc.claim.bind(rpc);
    rpc.claim = async (w: string) => {
      n += 1;
      if (n === 3) queue.push(job(JOB_A));
      return realClaim(w);
    };
    await runWorker(options({ stop: () => rpc.claims >= 5 }), {
      rpc,
      clock,
      sinkFor: () => new MemorySink(),
      sources: { cueProvider },
      generate,
    });
    expect(clock.sleeps).toEqual([2_000, 4_000, 2_000, 4_000]);

    const once = fakeRpc([]);
    const onceClock = fakeClock();
    await runWorker(options({ maxJobs: 1, exitWhenIdle: true }), {
      rpc: once,
      clock: onceClock,
      sinkFor: () => new MemorySink(),
      sources: { cueProvider },
    });
    expect(once.claims).toBe(1);
    expect(onceClock.sleeps).toEqual([]);
  });

  it("stops the loop when a job sent any Anthropic request", async () => {
    /* MUTATION THAT KILLS THIS: drop the `break` after the Anthropic count
       moved. The second job would run. Ran it — red. */
    const rpc = fakeRpc([job(JOB_A), job(JOB_B)]);
    let sent = 0;
    const stats = await runWorker(options({ stop: () => rpc.claims >= 3 }), {
      rpc,
      clock: fakeClock(),
      sinkFor: () => new MemorySink(),
      sources: { cueProvider },
      anthropicCalls: () => sent,
      generate: async () => {
        sent += 1;
        return { skipped: true, file: "x" };
      },
    });
    expect(stats.claimed).toBe(1);
    expect(stats.refused).toMatch(/1 Anthropic request\(s\) were sent/);
  });
});

describe("GV-105 — the prompt is never logged or written", () => {
  it("no sink call, no log line and no file under --out carries the prompt (SupabaseJobSink over a fake PostgREST)", async () => {
    /* MUTATION THAT KILLS THIS: drop the withRedactedConsole wrapper in
       runJob (the pipeline below echoes the request, and the driver's ERROR
       line carries the error text). Ran it — red. Also killed: drop
       `candidateKey` from runJob's deps (the candidate file is named after
       the prompt's slug). Ran it — red. */
    const row = {
      id: JOB_A,
      author_id: AUTHOR,
      status: "claimed",
      seq: 0,
      snapshot: null as unknown,
    };
    const fetchCalls: { url: string; body?: string }[] = [];
    const fetch: JobSinkFetch = async (url, init) => {
      fetchCalls.push({
        url,
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      const status = new URL(url).searchParams.get("status");
      if (init.method === "GET")
        return {
          ok: true,
          status: 200,
          json: async () => [
            { author_id: row.author_id, seq: row.seq, snapshot: row.snapshot },
          ],
        };
      if (status && !status.includes(row.status))
        return { ok: true, status: 200, json: async () => [] };
      Object.assign(row, JSON.parse(init.body!));
      return { ok: true, status: 200, json: async () => [{ seq: row.seq }] };
    };
    const rpc = fakeRpc([
      job(JOB_A),
      job(JOB_B, { prompt: `${PROMPT} (again)` }),
    ]);
    const stub = stubPipeline();
    await runWorker(options({ stop: () => rpc.claims >= 3 }), {
      rpc,
      clock: fakeClock(),
      sinkFor: (id) =>
        id === JOB_A
          ? new SupabaseJobSink({
              baseUrl: "https://example-ref.supabase.co",
              serviceKey: "k",
              jobId: id,
              fetch,
            })
          : new MemorySink(),
      sources: { cueProvider },
      runPipeline: (request, opts, deps) => {
        console.log(`  understand: "${request.prompt}"`);
        console.warn(`  slow stage for ${request.prompt.slice(0, 60)}`);
        if (request.prompt.endsWith("(again)"))
          throw new Error(`could not understand "${request.prompt}"`);
        return stub(request, opts, deps);
      },
    });
    expect(row.status).toBe("complete");
    expect(fetchCalls.length).toBeGreaterThan(2);
    for (const c of fetchCalls) {
      expect(c.url).not.toContain("grilling");
      expect(c.body ?? "").not.toContain(PROMPT);
      expect(c.body ?? "").not.toContain(PROMPT.slice(0, 40));
    }
    expect(lines.some((l) => l.includes("[prompt]"))).toBe(true);
    for (const l of lines) {
      expect(l).not.toContain(PROMPT.slice(0, 40));
    }
    const slug = candidateFilename(PROMPT).replace(/-[0-9a-f]{8}\.json$/, "");
    const files = allFiles(dir);
    expect(files.map((f) => path.basename(f))).toContain(`job-${JOB_A}.json`);
    for (const f of files) {
      expect(path.basename(f)).not.toContain(slug);
      expect(fs.readFileSync(f, "utf8")).not.toContain(PROMPT);
    }
  });

  it("generateOneCandidate's own lines name the prompt by promptLabel when one is given", async () => {
    /* MUTATION THAT KILLS THIS: ignore deps.promptLabel (log the prompt's
       first 60 characters as before). Ran it — red. */
    const args: CliArgs = {
      prompts: null,
      out: dir,
      duration: "short",
      limit: null,
      dryRun: false,
      authorId: AUTHOR,
      budgetUsd: null,
      noResume: false,
      maxResumes: 0,
      continueOnRefusedPartial: false,
      notify: null,
    };
    const result = await generateOneCandidate({ prompt: PROMPT }, args, {
      cueProvider,
      runPipeline: stubPipeline(),
      promptLabel: `job ${JOB_A}`,
      candidateKey: `job-${JOB_A}`,
    });
    expect(result.entry?.outcome).toBe("generated");
    expect(lines.some((l) => l.includes(`built  job ${JOB_A}`))).toBe(true);
    for (const l of lines) expect(l).not.toContain(PROMPT.slice(0, 40));
    expect(result.file).toBe(path.join(dir, `job-${JOB_A}.json`));
    await expect(
      generateOneCandidate({ prompt: PROMPT }, args, {
        cueProvider,
        candidateKey: "../escape",
      }),
    ).rejects.toThrow(/candidateKey/);
  });

  it("redactPrompt replaces the prompt and its long prefixes, and leaves short ordinary text alone", () => {
    /* MUTATION THAT KILLS THIS: redact only the whole prompt (the 60-character
       cut a log line makes would pass through). Ran it — red. */
    expect(redactPrompt(`a "${PROMPT}" b`, PROMPT)).toBe('a "[prompt]" b');
    expect(redactPrompt(`x ${PROMPT.slice(0, 60)} y`, PROMPT)).toBe(
      "x [prompt] y",
    );
    expect(redactPrompt("short", "short")).toBe("[prompt]");
    expect(redactPrompt("tell me about it", PROMPT)).toBe("tell me about it");
  });
});

describe("GV-105 — the zero-Anthropic start refusal", () => {
  it("refuses the relay, an Anthropic key, an Anthropic-routed stage and the legacy opt-in; allows stub and local", () => {
    /* MUTATION THAT KILLS THIS: drop the ANTHROPIC_BASE_URL check (a relay
       URL would then start the worker). Ran it — red. Also killed: drop the
       anthropic-route check (the legacy mode would be refused only for its
       opt-in variable, not for the stages it routes). Ran it — red. */
    expect(workerStartRefusal({})).toBeNull();
    expect(
      workerStartRefusal({ FORAY_LLM_BASE_URL: "http://litellm.test:4000" }),
    ).toBeNull();
    expect(
      workerStartRefusal({ ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" }),
    ).toMatch(/ANTHROPIC_BASE_URL is set/);
    expect(
      workerStartRefusal({
        ANTHROPIC_API_KEY: "sk-test",
        FORAY_LLM_BASE_URL: "http://litellm.test:4000",
      }),
    ).toMatch(/ANTHROPIC_API_KEY is set/);
    expect(
      workerStartRefusal({
        FORAY_GENERATION_MODE: "anthropic-legacy",
        FORAY_ALLOW_ANTHROPIC_LEGACY: "1",
      }),
    ).toMatch(/would be built on an Anthropic builder/);
    expect(workerStartRefusal({ FORAY_STAGE_SPINE: "anthropic" })).toMatch(
      /stage routing does not resolve \(FORAY_/,
    );
    expect(workerStartRefusal({ FORAY_ALLOW_ANTHROPIC_LEGACY: "1" })).toMatch(
      /FORAY_ALLOW_ANTHROPIC_LEGACY is set/,
    );
    /* Never a value in the message. */
    expect(
      workerStartRefusal({ ANTHROPIC_BASE_URL: "http://relay.secret.test" }),
    ).not.toContain("relay.secret");
  });

  it("a refused environment claims nothing", async () => {
    /* MUTATION THAT KILLS THIS: check the refusal after the first claim (or
       not at all). Ran it — red. */
    const rpc = fakeRpc([job(JOB_A)]);
    const stats = await runWorker(
      options({
        env: { ANTHROPIC_BASE_URL: "http://127.0.0.1:8787" },
        stop: () => rpc.claims >= 2,
      }),
      {
        rpc,
        clock: fakeClock(),
        sinkFor: () => new MemorySink(),
        sources: { cueProvider },
      },
    );
    expect(stats.refused).toMatch(/ANTHROPIC_BASE_URL/);
    expect(rpc.claims).toBe(0);
  });
});

describe("GV-105 — the Supabase RPC client and the CLI arguments", () => {
  const KEY = "service-key-SECRET-123";
  function rpcFetch(answer: unknown, status = 200) {
    const calls: {
      url: string;
      method: string;
      headers: Record<string, string>;
      body?: string;
    }[] = [];
    const fetch: WorkerFetch = async (url, init) => {
      calls.push({
        url,
        method: init.method,
        headers: init.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
      return { ok: status < 400, status, json: async () => answer };
    };
    return { calls, fetch };
  }

  it("claims through rpc/claim_generation_job with p_worker, reads the row, and reads an empty answer as an empty queue", async () => {
    /* MUTATION THAT KILLS THIS: send the worker as `worker` instead of
       `p_worker` (PostgREST would not find the function). Ran it — red. */
    const { calls, fetch } = rpcFetch([
      {
        id: JOB_A.toUpperCase(),
        author_id: AUTHOR,
        tier: "medium",
        lane: "on-demand",
        prompt: PROMPT,
      },
    ]);
    const rpc = new SupabaseWorkerRpc({
      baseUrl: "https://example-ref.supabase.co/",
      serviceKey: KEY,
      fetch,
    });
    expect(await rpc.claim("spark-1")).toEqual({
      id: JOB_A,
      authorId: AUTHOR,
      tier: "medium",
      lane: "on-demand",
      prompt: PROMPT,
    });
    expect(calls[0]).toMatchObject({
      url: "https://example-ref.supabase.co/rest/v1/rpc/claim_generation_job",
      method: "POST",
      body: JSON.stringify({ p_worker: "spark-1" }),
    });
    expect(calls[0]!.headers.Authorization).toBe(`Bearer ${KEY}`);
    expect(
      await new SupabaseWorkerRpc({
        baseUrl: "https://example-ref.supabase.co",
        serviceKey: KEY,
        fetch: rpcFetch([]).fetch,
      }).claim("spark-1"),
    ).toBeNull();
  });

  it("the heartbeat touches only an open row, and no error carries the key", async () => {
    /* MUTATION THAT KILLS THIS: drop the status guard from the heartbeat URL
       (a cancelled job would be touched back to life-looking). Ran it — red. */
    const { calls, fetch } = rpcFetch(null);
    await new SupabaseWorkerRpc({
      baseUrl: "https://example-ref.supabase.co",
      serviceKey: KEY,
      fetch,
    }).heartbeat(JOB_A, "spark-1");
    expect(calls[0]).toMatchObject({
      method: "PATCH",
      url: `https://example-ref.supabase.co/rest/v1/generation_jobs?id=eq.${JOB_A}&status=in.(claimed,running)`,
      body: JSON.stringify({ worker: "spark-1" }),
    });
    const failing = new SupabaseWorkerRpc({
      baseUrl: "https://example-ref.supabase.co",
      serviceKey: KEY,
      fetch: rpcFetch({ message: KEY }, 500).fetch,
    });
    await expect(failing.claim("spark-1")).rejects.toThrow(/HTTP 500/);
    await failing
      .claim("spark-1")
      .catch((err: Error) => expect(err.message).not.toContain(KEY));
    await failing
      .heartbeat(JOB_A, "spark-1")
      .catch((err: Error) => expect(err.message).not.toContain(KEY));
  });

  it("parseWorkerArgs defaults --out under data-local/, refuses one outside it, and reads --once and --render-spool", () => {
    /* MUTATION THAT KILLS THIS: drop the data-local refusal on --out (the
       worker could write candidates into the tracked tree). Ran it — red. */
    const parsed = parseWorkerArgs([], "box");
    expect(parsed).toMatchObject({
      worker: "spark-box",
      out: DEFAULT_WORKER_OUT,
      once: false,
    });
    expect("renderSpool" in parsed).toBe(false);
    expect(
      parseWorkerArgs(
        ["--once", "--render-spool", "/srv/spool", "--worker", "w1"],
        "box",
      ),
    ).toMatchObject({ once: true, renderSpool: "/srv/spool", worker: "w1" });
    expect(() => parseWorkerArgs(["--out", "data"], "box")).toThrow(
      /--out must be under data-local/,
    );
    expect(() => parseWorkerArgs(["--max-resumes", "-1"], "box")).toThrow(
      /--max-resumes/,
    );
  });
});
