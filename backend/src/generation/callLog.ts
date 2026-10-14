/**
 * GV-123 (docs/roadmap/generation-v2.md, from W4-01 items 4 and 5; R1-01,
 * GP-03, MT-06): builder-level spans, the ONE source of the critical path
 * (decision 28).
 *
 * `instrumentDeps(deps, clock)` returns a copy of a `RunPipelineDeps` whose
 * builders are wrapped: every call to a builder METHOD that stands for model
 * work records one span {id, stage, act, startMs, endMs} in an in-memory
 * array. criticalPath.ts's `serialCallChain` reads those spans.
 *
 * WHY THE BUILDER AND NOT THE PROVIDER. A span is taken where the pipeline
 * hands work to a builder, so it does not care which provider answers: a
 * scripted provider, a fake, a stub or a real model all produce the same
 * spans, and the chain can be pinned offline. The CallRecords that the
 * providers append (GV-07, GV-13, GV-20) stay the source of per-call SPEED
 * metrics only (tokens, queue, TTFT); they are not the critical path.
 *
 * THE LIMITATION, stated so nobody reads more into a span than it holds: a
 * builder method that makes several model calls (a JSON re-ask, a
 * continuation) is ONE span. The chain counts the waits the pipeline makes
 * on its builders, not the requests a provider sends (GV-117 records this).
 *
 * WHAT IT DOES NOT DO.
 *   - It writes nothing: the spans live in the returned array, never on disk
 *     (promptNoPersistence.test.ts's rule holds).
 *   - It changes no result: each wrapper returns (or throws) exactly what the
 *     builder did, with the builder as `this`.
 *   - Nothing in production calls it yet. GV-117 wires it into
 *     runForayPipeline under FORAY_FAST_PATH; until then the only caller is
 *     backend/test/helpers/recordingDeps.ts.
 *   - A builder the deps object leaves out (so runForayPipeline builds its
 *     default) is not instrumented: the caller passes the builders it wants
 *     measured.
 */

import type { RunPipelineDeps } from "./runPipeline";
import type { ActWriteRequest } from "./NarrationWriterBuilder";
import { currentCallContext } from "./runLog";

/** One builder-method call. `act` is null when neither the run context nor
 * the call's own arguments name an act (understand, research, spine, a
 * verifier or continuity call made outside a run log). */
export interface BuilderSpan {
  /** `<method>[@a<act>]#<n>`: n counts that method's calls for that act, from
   * 1, in the order the calls STARTED. Readable, and stable for a snapshot. */
  id: string;
  stage: string;
  builder: BuilderKey;
  method: string;
  act: number | null;
  startMs: number;
  endMs: number;
  /** False when the builder threw (or its stream did). The time still
   * counts: the pipeline waited on it. */
  ok: boolean;
}

/** The clock a span is read from. Production passes a wall clock; a test
 * passes a fake one (recordingDeps.ts). */
export type SpanClock = () => number;

/** What a hook is told about the call it runs inside. */
export interface SpanCall {
  id: string;
  stage: string;
  builder: BuilderKey;
  method: string;
  act: number | null;
}

export interface InstrumentHooks {
  /**
   * Awaited after the builder answered and before the span's end is read.
   * For a test's fake clock (a scripted latency per stage); production
   * leaves it out.
   */
  beforeEnd?: (call: SpanCall) => void | Promise<void>;
}

export type BuilderKey =
  | "understander"
  | "researcher"
  | "spineBuilder"
  | "deepenBuilder"
  | "narrationWriter"
  | "narrationVerifier"
  | "continuityBuilder";

interface MethodSpec {
  method: string;
  stage: string;
  /** The act an argument names, when the run context does not. */
  actFromArgs?: (args: unknown[]) => number | undefined;
  /** The method returns an AsyncIterable: the span runs until it ends. */
  stream?: boolean;
}

const actIndexOf = (args: unknown[]): number | undefined => {
  const request = args[0] as Partial<ActWriteRequest> | undefined;
  return typeof request?.frame?.actIndex === "number" ? request.frame.actIndex : undefined;
};

/**
 * Every builder method that stands for model work, by deps key. A method a
 * builder does not have (retrievePassages, writeActStream are optional) is
 * left absent, so `typeof builder.writeActStream === "function"` still reads
 * the builder's own answer.
 */
export const INSTRUMENTED_METHODS: Readonly<Record<BuilderKey, readonly MethodSpec[]>> = Object.freeze({
  understander: [
    { method: "assessClarity", stage: "understand" },
    { method: "extractIntent", stage: "understand" }
  ],
  researcher: [
    { method: "research", stage: "research" },
    { method: "retrievePassages", stage: "evidence" }
  ],
  spineBuilder: [{ method: "buildSpine", stage: "spine" }],
  deepenBuilder: [
    {
      method: "deepenAct",
      stage: "deepen",
      actFromArgs: (args: unknown[]) => (typeof args[2] === "number" ? args[2] : undefined)
    }
  ],
  narrationWriter: [
    { method: "writeAct", stage: "narration", actFromArgs: actIndexOf },
    { method: "writeActStream", stage: "narration", actFromArgs: actIndexOf, stream: true }
  ],
  narrationVerifier: [{ method: "verifyAct", stage: "verify" }],
  continuityBuilder: [{ method: "smoothSeam", stage: "continuity" }]
});

export interface InstrumentedDeps<D extends RunPipelineDeps> {
  /** `deps` with each present builder wrapped; every other key as given. */
  deps: D;
  /** The spans, appended as each call ENDS. */
  spans: BuilderSpan[];
}

type AnyFn = (...args: unknown[]) => unknown;

/** Wraps the builders of `deps` so every model-work method call records a
 * span read from `clock`. See the module comment. */
export function instrumentDeps<D extends RunPipelineDeps>(deps: D, clock: SpanClock, hooks: InstrumentHooks = {}): InstrumentedDeps<D> {
  const spans: BuilderSpan[] = [];
  const started = new Map<string, number>();

  const begin = (builder: BuilderKey, spec: MethodSpec, args: unknown[]): SpanCall & { startMs: number } => {
    const ctxAct = currentCallContext().act;
    const fromArgs = spec.actFromArgs?.(args);
    const act = typeof ctxAct === "number" ? ctxAct : typeof fromArgs === "number" ? fromArgs : null;
    const key = `${spec.method}${act === null ? "" : `@a${act}`}`;
    const n = (started.get(key) ?? 0) + 1;
    started.set(key, n);
    return { id: `${key}#${n}`, stage: spec.stage, builder, method: spec.method, act, startMs: clock() };
  };
  const finish = (call: SpanCall & { startMs: number }, ok: boolean): void => {
    spans.push({ ...call, endMs: clock(), ok });
  };

  const wrapMethod = (builder: BuilderKey, spec: MethodSpec, target: object, original: AnyFn): AnyFn => {
    if (spec.stream) {
      return (...args: unknown[]) => {
        const call = begin(builder, spec, args);
        let inner: AsyncIterable<unknown>;
        try {
          inner = original.apply(target, args) as AsyncIterable<unknown>;
        } catch (err) {
          finish(call, false);
          throw err;
        }
        return (async function* spanned() {
          let ok = false;
          try {
            yield* inner;
            await hooks.beforeEnd?.(call);
            ok = true;
          } finally {
            finish(call, ok);
          }
        })();
      };
    }
    return async (...args: unknown[]) => {
      const call = begin(builder, spec, args);
      let ok = false;
      try {
        const value = await original.apply(target, args);
        await hooks.beforeEnd?.(call);
        ok = true;
        return value;
      } finally {
        finish(call, ok);
      }
    };
  };

  const wrapBuilder = <B extends object>(key: BuilderKey, target: B): B => {
    const wrapped = new Map<PropertyKey, unknown>();
    for (const spec of INSTRUMENTED_METHODS[key]) {
      const original = (target as Record<string, unknown>)[spec.method];
      if (typeof original === "function") wrapped.set(spec.method, wrapMethod(key, spec, target, original as AnyFn));
    }
    const bound = new Map<PropertyKey, unknown>();
    return new Proxy(target, {
      get(obj, prop) {
        if (wrapped.has(prop)) return wrapped.get(prop);
        const value = Reflect.get(obj, prop, obj);
        if (typeof value !== "function") return value;
        /* Any other method runs on the builder itself, so a class with
           private fields keeps working behind the proxy. */
        if (!bound.has(prop)) bound.set(prop, (value as AnyFn).bind(obj));
        return bound.get(prop);
      }
    });
  };

  const out: D = { ...deps };
  for (const key of Object.keys(INSTRUMENTED_METHODS) as BuilderKey[]) {
    const builder = deps[key];
    if (builder) (out as Record<string, unknown>)[key] = wrapBuilder(key, builder as object);
  }
  return { deps: out, spans };
}
