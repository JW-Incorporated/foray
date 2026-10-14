import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { codeHit, codeSpan, codeSpanSync, flushCodeSpans } from "../src/generation/codeSpans";
import { RunLog, runWithRunLog, withCallContext, type CodeSpanAggregate } from "../src/generation/runLog";

/**
 * GV-85 (docs/roadmap/generation-v2.md; MT-08): code time below stage level,
 * aggregated per (stage, name) and appended to the run log only on flush.
 *
 * The clock is `performance.now`, pinned here to a counter the timed functions
 * advance, so every duration below is exact.
 */

let t = 0;
beforeEach(() => {
  t = 0;
  vi.spyOn(globalThis.performance, "now").mockImplementation(() => t);
});
afterEach(() => {
  vi.restoreAllMocks();
});

/** A function that "takes" `ms` on the pinned clock and returns `value`. */
const takes =
  <T>(ms: number, value: T) =>
  (): T => {
    t += ms;
    return value;
  };

function codeEvents(log: RunLog): CodeSpanAggregate[] {
  return log.events("code");
}

function find(log: RunLog, stage: string | null, name: string): CodeSpanAggregate | undefined {
  return codeEvents(log).find((e) => e.stage === stage && e.name === name);
}

describe("codeSpans — inert outside a run log", () => {
  it("returns exactly what the function returns, reads no clock and keeps no state", async () => {
    const obj = { a: 1 };
    expect(codeSpanSync("x", () => obj)).toBe(obj);
    const promise = Promise.resolve(obj);
    /* The very same promise, not a wrapper: no extra tick for a caller that never opened a log.
       MUTATION: outside a log return `fn().then((v) => v)`. Ran it: red. */
    expect(codeSpan("x", () => promise)).toBe(promise);
    await expect(promise).resolves.toBe(obj);
    codeHit("x");
    expect(globalThis.performance.now).not.toHaveBeenCalled();
    /* A log opened afterwards sees nothing of the calls made before it. */
    const log = new RunLog();
    expect(flushCodeSpans(log)).toBe(0);
    expect(codeEvents(log)).toEqual([]);
  });

  it("throws exactly what the function throws", () => {
    const boom = new Error("boom");
    expect(() =>
      codeSpanSync("x", () => {
        throw boom;
      })
    ).toThrow(boom);
  });
});

describe("codeSpans — aggregation per (stage, name)", () => {
  it("sums count, totalMs and keeps the max per stage and name", () => {
    const log = new RunLog();
    runWithRunLog(log, () => {
      withCallContext({ stage: "source" }, () => {
        expect(codeSpanSync("index.search", takes(7, "a"))).toBe("a");
        codeSpanSync("index.search", takes(3, "b"));
        codeSpanSync("index.load", takes(2, null));
      });
      withCallContext({ stage: "research-shape" }, () => {
        codeSpanSync("index.search", takes(5, 0));
      });
      /* No stage in the context: aggregated under stage null. */
      codeSpanSync("index.search", takes(1, 0));
    });
    /* Nothing reaches the log before the flush. */
    expect(codeEvents(log)).toEqual([]);
    expect(flushCodeSpans(log)).toBe(4);
    /* MUTATION: `if (ms > agg.maxMs) agg.maxMs = ms` -> `agg.maxMs = ms` (last, not max). Ran it: red (maxMs 3). */
    expect(find(log, "source", "index.search")).toEqual({
      kind: "code",
      stage: "source",
      name: "index.search",
      count: 2,
      totalMs: 10,
      maxMs: 7
    });
    expect(find(log, "source", "index.load")).toMatchObject({ count: 1, totalMs: 2, maxMs: 2 });
    /* MUTATION: aggregate key ignores the stage (`JSON.stringify([name])`). Ran it: red (3 events, counts merged). */
    expect(find(log, "research-shape", "index.search")).toMatchObject({ count: 1, totalMs: 5, maxMs: 5 });
    expect(find(log, null, "index.search")).toMatchObject({ count: 1, totalMs: 1, maxMs: 1 });
  });

  it("keys a span by the stage in force when it STARTS", () => {
    const log = new RunLog();
    runWithRunLog(log, () =>
      withCallContext({ stage: "outer" }, () =>
        codeSpanSync("sourcing.all", () => withCallContext({ stage: "inner" }, takes(4, 0)))
      )
    );
    flushCodeSpans(log);
    expect(codeEvents(log).map((e) => [e.stage, e.name])).toEqual([["outer", "sourcing.all"]]);
  });

  it("reports nested spans inclusively: the outer total includes the inner one", () => {
    const log = new RunLog();
    runWithRunLog(log, () =>
      codeSpanSync("index.search", () => {
        t += 1;
        codeSpanSync("index.load", takes(5, 0));
        t += 2;
      })
    );
    flushCodeSpans(log);
    expect(find(log, null, "index.load")).toMatchObject({ totalMs: 5 });
    expect(find(log, null, "index.search")).toMatchObject({ totalMs: 8 });
  });

  it("records a span whose function throws, and rethrows the same error", () => {
    const log = new RunLog();
    const boom = new Error("boom");
    runWithRunLog(log, () => {
      expect(() =>
        codeSpanSync("transcript.read", () => {
          t += 6;
          throw boom;
        })
      ).toThrow(boom);
    });
    flushCodeSpans(log);
    /* MUTATION: no `finally` — record only after `fn()` returned. Ran it: red (no event). */
    expect(find(log, null, "transcript.read")).toMatchObject({ count: 1, totalMs: 6, maxMs: 6 });
  });

  it("counts a hit without timing it", () => {
    const log = new RunLog();
    runWithRunLog(log, () =>
      withCallContext({ stage: "source" }, () => {
        codeHit("transcript.cacheHit");
        codeHit("transcript.cacheHit");
        codeHit("transcript.cacheHit");
      })
    );
    flushCodeSpans(log);
    expect(find(log, "source", "transcript.cacheHit")).toMatchObject({ count: 3, totalMs: 0, maxMs: 0 });
    expect(globalThis.performance.now).not.toHaveBeenCalled();
  });
});

describe("codeSpans — the async variant", () => {
  it("times until the promise settles, resolved or rejected", async () => {
    const log = new RunLog();
    let release!: (v: string) => void;
    let fail!: (e: Error) => void;
    await runWithRunLog(log, async () => {
      const ok = codeSpan("supply.measure", () => new Promise<string>((r) => (release = r)));
      const bad = codeSpan("supply.measure", () => new Promise<string>((_r, j) => (fail = j)));
      t += 9;
      release("done");
      await expect(ok).resolves.toBe("done");
      t += 4;
      const err = new Error("nope");
      fail(err);
      await expect(bad).rejects.toBe(err);
    });
    flushCodeSpans(log);
    /* MUTATION: record when `fn()` returns instead of when it settles. Ran it: red (totalMs 0). */
    expect(find(log, null, "supply.measure")).toMatchObject({ count: 2, totalMs: 22, maxMs: 13 });
  });
});

describe("codeSpans — flush", () => {
  it("appends at most one aggregate per (stage, name), however often it is called", () => {
    const log = new RunLog();
    runWithRunLog(log, () =>
      withCallContext({ stage: "source" }, () => {
        codeSpanSync("sourcing.tier2", takes(2, 0));
        expect(flushCodeSpans(log)).toBe(1);
        /* MUTATION: drop the `flushed` check in flushCodeSpans. Ran it: red (2 aggregates, returns 1). */
        expect(flushCodeSpans(log)).toBe(0);
        /* A span after the flush folds into the aggregate already in the log. */
        codeSpanSync("sourcing.tier2", takes(3, 0));
        expect(flushCodeSpans(log)).toBe(0);
      })
    );
    const events = codeEvents(log);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ stage: "source", name: "sourcing.tier2", count: 2, totalMs: 5, maxMs: 3 });
    const keys = events.map((e) => `${e.stage}|${e.name}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("keeps two logs apart", () => {
    const a = new RunLog();
    const b = new RunLog();
    runWithRunLog(a, () => codeSpanSync("index.load", takes(1, 0)));
    runWithRunLog(b, () => codeHit("transcript.cacheHit"));
    flushCodeSpans(a);
    flushCodeSpans(b);
    expect(codeEvents(a).map((e) => e.name)).toEqual(["index.load"]);
    expect(codeEvents(b).map((e) => e.name)).toEqual(["transcript.cacheHit"]);
  });

  it("serialises the aggregates in the runlog/1 JSONL", () => {
    const log = new RunLog();
    runWithRunLog(log, () => withCallContext({ stage: "source" }, () => codeSpanSync("sourcing.all", takes(4, 0))));
    flushCodeSpans(log);
    const lines = log
      .toJsonl()
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l) as Record<string, unknown>);
    expect(lines[1]).toEqual({ kind: "code", stage: "source", name: "sourcing.all", count: 1, totalMs: 4, maxMs: 4 });
  });
});
