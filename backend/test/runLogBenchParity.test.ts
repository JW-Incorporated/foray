import { describe, it, expect } from "vitest";
import { z } from "zod";
import { runForayPipeline } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import { parseWithRetry } from "../src/generation/parseWithRetry";
import { RunLog, currentRunLog, recordModelCall, runWithRunLog, type CallRecord } from "../src/generation/runLog";
import type { GenerationRequest } from "../src/types/generation";

/**
 * GV-17 (docs/roadmap/generation-v2.md): the parity pin between the runlog's
 * EMITTER (backend/src/generation/runLog.ts, GV-01/GV-07) and its READER
 * (tools/generation-bench/runlog.mjs). The two live on opposite sides of the
 * founder-label line and share no code: the reader is an ESM tools script,
 * the emitter is CommonJS TypeScript. Without this suite a field renamed on
 * either side reads as "absent" in every bench row from then on, which is
 * exactly the quiet failure rule 1 makes look honest.
 *
 * A stub pipeline runs under a real RunLog. Test-local builders wrap the
 * Stubs and record one model request each through `recordModelCall` — the
 * provider choke point every provider (anthropicCall.ts, the OpenAI-compatible
 * client, the Jev client) appends through — so the records carry the stage,
 * act, round and role the REAL context machinery sets. The spine wrapper also
 * sends a bad reply through the real `parseWithRetry`, so the log holds a real
 * JSON re-ask and its parse events. No Anthropic call and no network: the
 * records are made in-process with an OpenAI-compatible provider's fields.
 *
 * `RunLog.toJsonl()` is fed to `summarizeRunLog` through a dynamic import of
 * the .mjs (as actNarration.test.ts imports check-narration.mjs). That import
 * fails under Vitest on a Windows checkout whose path contains a space; CI
 * and a space-free worktree run it.
 */

type Summary = {
  calls: number;
  callsByStage: Record<string, number>;
  promptTokens: number | null;
  cachedTokens: number | null;
  outputTokens: number | null;
  outputTokensByStage: Record<string, number | null>;
  perStage: Record<string, { calls: number; outputTokens: number | null; ms: number }>;
  seriesDepth: number;
  repeatWork: { jsonReasks: number; spineReasks: number; extraRounds: number; continuations: number; parseFailures: number };
  prose: { tokPerSec: number | null; basis: string | null };
};
type Reader = {
  RUNLOG_SCHEMA: string;
  EVENT_KINDS: readonly string[];
  CALL_FIELDS: readonly string[];
  parseRunLog: (text: string, label?: string) => { header: { schema: string; t0Iso: string }; events: Array<Record<string, unknown>> };
  summarizeRunLog: (events: unknown[]) => Summary;
};
const loadReader = async () => (await import("../../tools/generation-bench/runlog.mjs")) as Reader;

const request: GenerationRequest = {
  prompt: "the history of grilling and barbecue",
  duration: "short",
  author_id: "founder-1",
  visibility: "catalogue"
};

const options = {
  userId: "founder-1",
  now: () => new Date("2026-09-05T12:00:00.000Z"),
  topic: "food/grilling-bbq"
};

/** The fake §4.9: a clean pass, so the chain runs to the end without the
 * real .mjs checkers (runPipeline.test.ts's recordingFinalize). */
async function passFinalize(input: FinalizeForayInput): Promise<FinalizeForayResult> {
  return {
    validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
    forayRecord: { id: input.id, generated: true } as never,
    timings: []
  } as unknown as FinalizeForayResult;
}

/** One model request recorded where a provider records it, on the log's own
 * clock. Every measurement an OpenAI-compatible server reports is set, so the
 * reader's queue, TTFT, cache and decode paths all see real records. */
async function recordCall(label: string, outputTokens: number): Promise<void> {
  const log = currentRunLog();
  if (!log) throw new Error("recordCall outside a RunLog");
  const startMs = log.nowMs();
  await new Promise<void>((resolve) => setImmediate(resolve));
  const endMs = log.nowMs();
  recordModelCall({
    provider: "openai-compat",
    machine: "spark",
    model: "parity-model",
    label,
    startMs,
    endMs,
    queueMs: 1,
    ttftMs: 1,
    promptTokens: 100,
    cachedTokens: 40,
    outputTokens,
    outputBudget: 1000,
    overBudget: false,
    stopReason: "stop"
  });
}

function recordingDeps() {
  const spine = new StubSpineBuilder();
  const deepen = new StubDeepenActBuilder();
  const writer = new StubNarrationWriterBuilder();
  const verifier = new StubNarrationVerifierBuilder();
  return {
    understander: new StubPromptUnderstander(),
    researcher: new StubExternalResearcher(),
    continuityBuilder: new StubContinuityBuilder(),
    finalize: passFinalize,
    spineBuilder: {
      providerName: spine.providerName,
      buildSpine: async (...args: Parameters<typeof spine.buildSpine>) => {
        await recordCall("spine", 900);
        /* A reply that is not JSON, then one re-ask through the real
           parseWithRetry: a CallRecord with reask 'json' and two parse
           events (a failure, then a re-asked success). */
        await parseWithRetry(z.object({ ok: z.literal(true) }), "not json", "parity spine", async () => {
          await recordCall("spine-reask", 120);
          return '{"ok":true}';
        });
        return spine.buildSpine(...args);
      }
    },
    deepenBuilder: {
      providerName: deepen.providerName,
      deepenAct: async (...args: Parameters<typeof deepen.deepenAct>) => {
        await recordCall("deepen", 200);
        return deepen.deepenAct(...args);
      }
    },
    narrationWriter: {
      providerName: writer.providerName,
      writeAct: async (...args: Parameters<typeof writer.writeAct>) => {
        await recordCall("writer", 300);
        return writer.writeAct(...args);
      }
    },
    narrationVerifier: {
      providerName: verifier.providerName,
      verifyAct: async (...args: Parameters<typeof verifier.verifyAct>) => {
        await recordCall("verifier", 50);
        return verifier.verifyAct(...args);
      }
    }
  };
}

/** A RunLog on a clock that moves 5 ms per read, so every call has a
 * duration longer than its TTFT and the decode rate is defined. */
function steppedLog(): RunLog {
  let t = Date.parse("2026-10-11T00:00:00.000Z");
  return new RunLog({ now: () => (t += 5) });
}

async function stubRun(): Promise<RunLog> {
  const log = steppedLog();
  const out = await runWithRunLog(log, () => runForayPipeline(request, options, recordingDeps()));
  expect(out.outcome).toBe("generated");
  return log;
}

describe("runlog emitter and bench reader parity (GV-17)", () => {
  it("summarizeRunLog's call count and token totals equal the RunLog's own for a stub run", async () => {
    /* MUTATION THAT KILLS THIS: in runlog.mjs, file calls by `c.label`
       instead of `c.stage` (callsByStage then disagrees with the log's own
       stages), or rename `outputTokens` in recordModelCall's record. Ran
       both — red. */
    const reader = await loadReader();
    const log = await stubRun();
    const totals = log.callTotals();
    expect(totals.calls).toBeGreaterThan(4);

    const parsed = reader.parseRunLog(log.toJsonl(), "parity");
    expect(parsed.header).toEqual({ schema: reader.RUNLOG_SCHEMA, t0Iso: log.t0Iso });
    expect(parsed.events).toHaveLength(log.events().length);
    const s = reader.summarizeRunLog(parsed.events);

    expect(s.calls).toBe(totals.calls);
    expect(s.outputTokens).toBe(totals.outputTokens);
    expect(s.promptTokens).toBe(totals.promptTokens);
    expect(s.cachedTokens).toBe(totals.cachedTokens);

    const byStage: Record<string, number> = {};
    const outByStage: Record<string, number> = {};
    for (const c of log.calls()) {
      const key = c.stage ?? "(none)";
      byStage[key] = (byStage[key] ?? 0) + 1;
      outByStage[key] = (outByStage[key] ?? 0) + (c.outputTokens ?? 0);
    }
    expect(s.callsByStage).toEqual(byStage);
    expect(s.outputTokensByStage).toEqual(outByStage);
    /* Every stage that made a call is a pipeline stage, not the fallback. */
    expect(Object.keys(byStage)).not.toContain("(none)");
    expect(Object.keys(byStage)).toEqual(expect.arrayContaining(["spine", "deepen", "narrate:0"]));
    for (const [stage, group] of Object.entries(s.perStage)) {
      const own = log.calls().filter((c) => (c.stage ?? "(none)") === stage);
      expect(group.calls).toBe(own.length);
      expect(group.ms).toBe(own.reduce((sum, c) => sum + c.ms, 0));
    }
    expect(s.seriesDepth).toBeGreaterThanOrEqual(3);
    expect(s.seriesDepth).toBeLessThanOrEqual(totals.calls);
  }, 60_000);

  it("the repeat work and the writer's prose rate the reader sees are the ones the backend's context recorded", async () => {
    /* MUTATION THAT KILLS THIS: change parseWithRetry's
       withCallContext({ reask: "json" }) to another word — the reader's
       jsonReasks then reads 0. Ran it — red. */
    const reader = await loadReader();
    const log = await stubRun();
    const s = reader.summarizeRunLog(reader.parseRunLog(log.toJsonl()).events);
    const calls: CallRecord[] = log.calls();
    const jsonReasks = calls.filter((c) => c.reask === "json");
    expect(jsonReasks.length).toBeGreaterThan(0);
    for (const c of jsonReasks) expect(c.stage).toBe("spine");
    expect(s.repeatWork.jsonReasks).toBe(jsonReasks.length);
    const parseFailures = log.events("parse").filter((p) => !p.ok);
    expect(s.repeatWork.parseFailures).toBe(parseFailures.length);
    /* The stub writer passes on round 1, so no extra rounds. */
    expect(s.repeatWork.extraRounds).toBe(calls.filter((c) => c.role === "writer" && (c.attempt ?? 0) > 1 && c.reask === null).length);
    /* Writer records carry a TTFT, so the prose rate is the decode rate. */
    const writers = calls.filter((c) => c.role === "writer");
    expect(writers.length).toBeGreaterThan(0);
    const decodeMs = writers.reduce((sum, c) => sum + (c.ms - (c.ttftMs ?? 0)), 0);
    const out = writers.reduce((sum, c) => sum + (c.outputTokens ?? 0), 0);
    expect(s.prose.basis).toBe("ttft");
    expect(s.prose.tokPerSec).toBeCloseTo(out / (decodeMs / 1000), 9);
  }, 60_000);

  it("every event kind and every CallRecord field the reader uses is what the emitter writes", async () => {
    /* MUTATION THAT KILLS THIS: rename `ttftMs` in runLog.ts's CallRecord
       (and recordModelCall), or drop "parse" from runlog.mjs's EVENT_KINDS.
       Ran the second — red. */
    const reader = await loadReader();
    const log = await stubRun();
    const events = reader.parseRunLog(log.toJsonl()).events;
    const kinds = new Set(events.map((e) => e.kind as string));
    for (const kind of kinds) expect(reader.EVENT_KINDS).toContain(kind);
    expect([...kinds]).toEqual(expect.arrayContaining(["stage", "call", "parse"]));
    for (const e of events.filter((ev) => ev.kind === "call")) {
      for (const field of reader.CALL_FIELDS) expect(Object.prototype.hasOwnProperty.call(e, field)).toBe(true);
    }
  }, 60_000);
});
