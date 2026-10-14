import { instrumentDeps, type BuilderSpan, type SpanCall } from "../../src/generation/callLog";
import type { RunPipelineDeps } from "../../src/generation/runPipeline";

/**
 * GV-123: `instrumentDeps` (backend/src/generation/callLog.ts) on a FAKE
 * clock that advances by a scripted latency per stage, so a stub or scripted
 * pipeline run yields the same builder spans, and so the same serial chain,
 * on every machine.
 *
 * VIRTUAL TIME, NOT A COUNTER. A clock that simply added each call's latency
 * would make every call look serial, and the chain would count parallel work
 * (the per-act deepen calls, say) as several waits. Here each wrapped call,
 * once its builder has answered, SLEEPS its stage's latency in virtual time.
 * The clock only moves when every pending piece of work is asleep: after a
 * few event-loop turns with nothing new, it jumps to the earliest wake-up and
 * resolves that one sleeper. Two calls that start together therefore end
 * together and overlap, exactly as two concurrent model calls would.
 *
 * The spans are the ones `instrumentDeps` records; this helper adds only the
 * clock and the sleep (through instrumentDeps's `beforeEnd` hook).
 */

/** Scripted latency, ms, by span stage (understand, research, evidence,
 * spine, deepen, narration, verify, continuity). A stage not listed costs
 * `defaultMs`. */
export type StageLatencies = Partial<Record<string, number>>;

/** Event-loop turns with no new sleeper before the clock may move. The stub
 * pipeline reaches its next builder call within a turn or two; the margin
 * keeps a slower stretch of in-process work from being overtaken. */
const SETTLE_TURNS = 8;

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

export class VirtualClock {
  private t: number;
  private seq = 0;
  private readonly timers: Array<{ at: number; seq: number; resolve: () => void }> = [];
  private pumping = false;
  private changed = false;

  constructor(startMs = 0) {
    this.t = startMs;
  }

  /** The current virtual time, ms. */
  readonly now = (): number => this.t;

  /** Resolves once virtual time reaches now + ms. */
  sleep(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      this.timers.push({ at: this.t + Math.max(0, ms), seq: this.seq++, resolve });
      this.changed = true;
      void this.pump();
    });
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      while (this.timers.length > 0) {
        /* Wait until a full SETTLE_TURNS pass registers no new sleeper. */
        do {
          this.changed = false;
          for (let i = 0; i < SETTLE_TURNS; i++) await turn();
        } while (this.changed);
        this.timers.sort((a, b) => a.at - b.at || a.seq - b.seq);
        const next = this.timers.shift()!;
        if (next.at > this.t) this.t = next.at;
        next.resolve();
      }
    } finally {
      this.pumping = false;
    }
  }
}

export interface RecordingDeps<D extends RunPipelineDeps> {
  deps: D;
  spans: BuilderSpan[];
  clock: VirtualClock;
}

/** Wraps `deps` with instrumentDeps on a virtual clock; each builder call
 * takes `latencies[stage]` (or `defaultMs`) of virtual time. */
export function recordingDeps<D extends RunPipelineDeps>(deps: D, latencies: StageLatencies, defaultMs = 1000): RecordingDeps<D> {
  const clock = new VirtualClock();
  const instrumented = instrumentDeps(deps, clock.now, {
    beforeEnd: (call: SpanCall) => clock.sleep(latencies[call.stage] ?? defaultMs)
  });
  return { deps: instrumented.deps, spans: instrumented.spans, clock };
}
