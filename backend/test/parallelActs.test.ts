import { describe, it, expect, vi } from "vitest";
import {
  writeNarration,
  createActGate,
  narrationActConcurrency,
  DEFAULT_NARRATION_ACT_CONCURRENCY,
  NARRATION_ACT_CONCURRENCY_ENV,
  type WrittenSlot
} from "../src/generation/writeNarration";
import { runForayPipeline } from "../src/generation/runPipeline";
import { StubPromptUnderstander } from "../src/generation/StubPromptUnderstander";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { StubContinuityBuilder } from "../src/generation/StubContinuityBuilder";
import { FakeCheckpointStore } from "./helpers/fakeCheckpointStore";
import { checkpointFingerprint } from "../src/generation/checkpoint";
import type { FinalizeForayInput, FinalizeForayResult } from "../src/generation/finalizeForay";
import type { GenerationRequest } from "../src/types/generation";
import type { SourcedAct } from "../src/types/tapeSourcing";
import type { Spine, Voice } from "../src/types/spine";
import type { SpineBuilder } from "../src/generation/SpineBuilder";
import type { ContinuityBuilder } from "../src/generation/ContinuityBuilder";
import type { NarrationBuildContext, NarrationWriterBuilder } from "../src/generation/NarrationWriterBuilder";
import type { EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type { PartialCandidate } from "../src/generation/partialCandidate";

/**
 * G-32 (docs/curation/foray-to-spec-roadmap.md; latency model §3 M1): acts
 * are narrated in parallel, stitch and continuity stay in act order.
 *
 * THE MEASUREMENT THAT NAMED IT. On a keyed run each later act adds 2–5.5
 * minutes IN SERIES after act 1 is playable (latency brief §2.3) — 6–16
 * minutes of a medium Foray — for no reason other than the `for` loop in
 * `writeNarration` and the one in `runPipeline` that waited on `narrate:i`
 * before starting `narrate:i+1`. Nothing in one act's narration reads
 * another act's text. What does depend on act order is §4.8: the
 * continuity call at each boundary and the partial candidate's
 * `itemsSoFar`, and those still run one act at a time.
 *
 * Every builder is a Stub, so the suite costs nothing and needs no key. The
 * latches below are how a test PROVES overlap rather than timing it: a slot
 * that is held cannot finish, so anything that starts while it is held
 * demonstrably did not wait for it.
 */

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
const ctx: NarrationBuildContext = { userId: "founder-1" };

const DOC: EvidenceDoc = {
  docId: "print:nbs-143",
  kind: "print",
  title: "National Bureau of Standards, Building Science Series 143 (1982)",
  url: "https://nvlpubs.nist.gov/nistpubs/Legacy/BSS/nbsbuildingscience143.pdf",
  retrievedAt: "2026-09-09T00:00:00.000Z",
  text:
    "The box beam-hanger rod connections were not checked for adequacy at any stage of the design. " +
    "The as-built connection could support about sixty percent of the load required by the Kansas City Building Code."
};

const gatherer: EvidenceGatherer = {
  async gather(beat): Promise<EvidencePack> {
    return { purpose: beat.claim, beatKind: "account", docs: [DOC] };
  }
};

/** `n` one-slot narration acts with titles a log can tell apart. */
function acts(n: number): SourcedAct[] {
  return Array.from({ length: n }, (_, i) => ({
    title: `Act ${i}`,
    slots: [
      {
        title: `A${i}S0`,
        beats: [{ sourcing: "narration", claim: `Claim ${i} about the connection.`, exploration: false, narration: { mode: "Patch", reason: "t" } }]
      }
    ]
  }));
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/* The stub pipeline spends 3–5 s in understand/spine/deepen/source before a
   single narration call (the FIRST run in a worker also warms the catalogue
   caches, which under a full parallel `vitest run` on the founder's PC has
   taken over a minute), and several tests below run it twice. A ceiling, not
   a wait: a passing test ends the moment its last assertion does. */
vi.setConfig({ testTimeout: 180_000 });

/** Polls until `pred` holds, or fails with `what` after `ms` — so a reverted
 * loop fails the test with a sentence instead of hanging it. The default is
 * generous for the same reason as the timeout above: it is a ceiling, not a
 * wait — a passing test leaves the moment the predicate holds. */
async function waitFor(pred: () => boolean, what: string, ms = 20_000): Promise<void> {
  const until = Date.now() + ms;
  while (!pred()) {
    if (Date.now() > until) throw new Error(`waited ${ms} ms for: ${what}`);
    await new Promise((r) => setTimeout(r, 5));
  }
}

const settle = (ms = 25) => new Promise((r) => setTimeout(r, ms));

/**
 * A stub writer whose `writePages` can be HELD per slot. `started` is the
 * order slots were requested in; `completed` the order they finished;
 * `inFlight`/`peak` count slots currently inside `writePages`. `hold`
 * returns the latch to await for a slot, or nothing to let it through.
 */
function holdingWriter(hold: (slotTitle: string) => Promise<void> | undefined = () => undefined) {
  const writer = new StubNarrationWriterBuilder();
  const real = writer.writePages.bind(writer);
  const state = { started: [] as string[], completed: [] as string[], timeline: [] as string[], inFlight: 0, peak: 0 };
  writer.writePages = async (...args: Parameters<NarrationWriterBuilder["writePages"]>) => {
    const title = args[0].slotTitle;
    state.started.push(title);
    state.timeline.push(`start:${title}`);
    state.inFlight++;
    state.peak = Math.max(state.peak, state.inFlight);
    try {
      const latch = hold(title);
      if (latch) await latch;
      return await real(...args);
    } finally {
      state.inFlight--;
      state.completed.push(title);
      state.timeline.push(`done:${title}`);
    }
  };
  return { writer, state };
}

describe("writeNarration — acts are narrated in parallel (G-32)", () => {
  it("starts every act without waiting for the one before it", async () => {
    /* MUTATION THAT KILLS THIS: put the `for (actIndex …)` loop back in
       `writeNarration` (await each act's `Promise.all` before starting the
       next). Act 1's slot is then never requested while act 0's is held, and
       `waitFor` fails. Ran it — red. */
    const act0 = deferred();
    const { writer, state } = holdingWriter((title) => (title === "A0S0" ? act0.promise : undefined));

    const run = writeNarration(acts(3), { writer, verifier: new StubNarrationVerifierBuilder(), evidence: gatherer }, voice, ctx);

    await waitFor(() => state.started.includes("A1S0") && state.started.includes("A2S0"), "acts 1 and 2 to start while act 0 is held");
    expect(state.completed).not.toContain("A0S0");
    act0.resolve();

    const written = await run;
    expect(written.map((a) => a.title)).toEqual(["Act 0", "Act 1", "Act 2"]);
  });

  it("returns acts in act order even when a later act finishes first", async () => {
    /* MUTATION THAT KILLS THIS: collect written acts by `push` on completion
       instead of by index. Act 0 finishes last here, so it comes back last.
       Ran it — red. */
    const act0 = deferred();
    const { writer, state } = holdingWriter((title) => (title === "A0S0" ? act0.promise : undefined));

    const run = writeNarration(acts(3), { writer, verifier: new StubNarrationVerifierBuilder(), evidence: gatherer }, voice, ctx);
    await waitFor(() => state.completed.includes("A1S0") && state.completed.includes("A2S0"), "acts 1 and 2 to finish before act 0");
    act0.resolve();

    const written = await run;
    expect(state.completed[state.completed.length - 1]).toBe("A0S0");
    expect(written.map((a) => a.title)).toEqual(["Act 0", "Act 1", "Act 2"]);
    expect(written.map((a) => a.slots[0]!.title)).toEqual(["A0S0", "A1S0", "A2S0"]);
  });

  it("never has more than `actConcurrency` acts in flight", async () => {
    /* MUTATION THAT KILLS THIS: ignore `actConcurrency` (`createActGate(acts.length)`).
       All six slots start at once and `peak` reads 6. Ran it — red. */
    const all = deferred();
    const { writer, state } = holdingWriter(() => all.promise);

    const run = writeNarration(acts(6), { writer, verifier: new StubNarrationVerifierBuilder(), evidence: gatherer, actConcurrency: 2 }, voice, ctx);

    await waitFor(() => state.started.length === 2, "two acts to start");
    await settle();
    /* Still two: the gate is holding the other four back, not merely slow. */
    expect(state.started).toEqual(["A0S0", "A1S0"]);
    all.resolve();

    const written = await run;
    expect(written).toHaveLength(6);
    expect(state.peak).toBe(2);
    expect(state.started).toEqual(["A0S0", "A1S0", "A2S0", "A3S0", "A4S0", "A5S0"]);
  });

  it("a cap of 1 is the pre-G-32 series: each act starts only after the previous one finished", async () => {
    /* MUTATION THAT KILLS THIS: the same as above — a gate that does not
       gate. Act 1 starts before act 0 completes. Ran it — red. */
    const latches = new Map([0, 1, 2].map((i) => [`A${i}S0`, deferred()]));
    const { writer, state } = holdingWriter((title) => latches.get(title)?.promise);

    const run = writeNarration(acts(3), { writer, verifier: new StubNarrationVerifierBuilder(), evidence: gatherer, actConcurrency: 1 }, voice, ctx);

    for (const i of [0, 1, 2]) {
      await waitFor(() => state.started.includes(`A${i}S0`), `act ${i} to start`);
      await settle();
      expect(state.started).toHaveLength(i + 1);
      expect(state.inFlight).toBe(1);
      latches.get(`A${i}S0`)!.resolve();
    }
    await run;
    expect(state.peak).toBe(1);
  });

  it("reads the cap from NARRATION_ACT_CONCURRENCY, defaults to 4, and refuses a malformed value by name", async () => {
    /* MUTATION THAT KILLS THIS: `return DEFAULT` on a malformed value instead
       of throwing — a typo would silently become 4 on the rate-limited key
       the operator was throttling. Ran it — red. */
    expect(DEFAULT_NARRATION_ACT_CONCURRENCY).toBe(4);
    expect(narrationActConcurrency(undefined)).toBe(4);
    expect(narrationActConcurrency("2")).toBe(2);
    expect(narrationActConcurrency(" 3 ")).toBe(3);
    for (const bad of ["0", "-1", "banana", "", "  ", "2.5"]) {
      expect(() => narrationActConcurrency(bad)).toThrow(NARRATION_ACT_CONCURRENCY_ENV);
    }
    /* `env.ts`'s convention: the message names the variable, never the value. */
    expect(() => narrationActConcurrency("banana")).not.toThrow(/banana/);

    /* And the env is what `writeNarration` consults when no option is given. */
    const previous = process.env[NARRATION_ACT_CONCURRENCY_ENV];
    process.env[NARRATION_ACT_CONCURRENCY_ENV] = "1";
    try {
      const all = deferred();
      const { writer, state } = holdingWriter(() => all.promise);
      const run = writeNarration(acts(3), { writer, verifier: new StubNarrationVerifierBuilder(), evidence: gatherer }, voice, ctx);
      await waitFor(() => state.started.length === 1, "one act to start");
      await settle();
      expect(state.started).toEqual(["A0S0"]);
      all.resolve();
      await run;
      expect(state.peak).toBe(1);
    } finally {
      if (previous === undefined) delete process.env[NARRATION_ACT_CONCURRENCY_ENV];
      else process.env[NARRATION_ACT_CONCURRENCY_ENV] = previous;
    }
  });

  it("on a failure: reports the failing act's error, lets in-flight acts finish and bank, and never starts the queued ones", async () => {
    /* Four acts, cap 2: act 0 and act 1 in flight, acts 2 and 3 queued. Act 0
       fails; act 1 is still held. The call must NOT return until act 1 has
       finished (its slot is banked through `onSlotWritten`), and acts 2 and 3
       must never be asked for.

       MUTATION THAT KILLS THIS: `Promise.all` over the acts instead of
       `allSettled` + `gate.abort`. The rejection surfaces the instant act 0
       throws — while act 1 is still held — so `pending` reads false below.
       Ran it — red. */
    const fail = deferred();
    const act1 = deferred();
    const { writer, state } = holdingWriter((title) => (title === "A1S0" ? act1.promise : undefined));
    const real = writer.writePages;
    writer.writePages = async (...args) => {
      if (args[0].slotTitle === "A0S0") {
        state.started.push("A0S0");
        await fail.promise;
        throw new Error("provider went away mid-slot");
      }
      return real(...args);
    };
    const banked: string[] = [];

    let pending = true;
    const run = writeNarration(
      acts(4),
      {
        writer,
        verifier: new StubNarrationVerifierBuilder(),
        evidence: gatherer,
        actConcurrency: 2,
        onSlotWritten: (_a, _s, slot: WrittenSlot) => {
          banked.push(slot.title);
        }
      },
      voice,
      ctx
    ).finally(() => {
      pending = false;
    });
    run.catch(() => undefined);

    await waitFor(() => state.started.includes("A0S0") && state.started.includes("A1S0"), "acts 0 and 1 to start");
    fail.resolve();
    await settle();
    expect(pending).toBe(true);
    expect(banked).toEqual([]);

    act1.resolve();
    await expect(run).rejects.toThrow(/provider went away/);
    expect(banked).toEqual(["A1S0"]);
    expect(state.started).not.toContain("A2S0");
    expect(state.started).not.toContain("A3S0");
  });

  it("createActGate: FIFO, capped, and abort rejects only what has not started", async () => {
    /* MUTATION THAT KILLS THIS: in `abort`, reject in-flight tasks too (or
       in `next`, skip the `aborted` check so queued tasks start). Ran both —
       red. */
    expect(() => createActGate(0)).toThrow(/positive integer/);
    const gate = createActGate(1);
    const first = deferred();
    const order: string[] = [];
    const a = gate.run(async () => {
      order.push("a");
      await first.promise;
      return "a";
    });
    const b = gate.run(async () => {
      order.push("b");
      return "b";
    });
    b.catch(() => undefined);
    await settle(5);
    expect(order).toEqual(["a"]);
    gate.abort(new Error("stop"));
    await expect(b).rejects.toThrow("stop");
    first.resolve();
    await expect(a).resolves.toBe("a");
    expect(order).toEqual(["a"]);
    await expect(gate.run(async () => "c")).rejects.toThrow("stop");
  });
});

/* ------------------------------------------------------------------------ */

const request: GenerationRequest = {
  prompt: "the history of grilling and barbecue",
  duration: "medium",
  author_id: "founder-1",
  visibility: "catalogue"
};

const options = { userId: "founder-1", now: () => new Date("2026-09-05T12:00:00.000Z"), topic: "food/grilling-bbq" };

function fakeFinalize() {
  return async (input: FinalizeForayInput): Promise<FinalizeForayResult> =>
    ({
      validation: { ok: true, checkForaysErrors: [], checkForaysWarnings: [], checkNarrationErrors: [], checkNarrationWarnings: [] },
      forayRecord: { id: input.id, generated: true } as never,
      timings: []
    }) as unknown as FinalizeForayResult;
}

/** Captures the frozen spine — the only thing that says which act a slot
 * title belongs to — and refuses to proceed if titles are not unique. */
function capturingSpine() {
  const builder = new StubSpineBuilder();
  const real = builder.buildSpine.bind(builder);
  const captured: { spine: Spine | null } = { spine: null };
  builder.buildSpine = async (...args: Parameters<SpineBuilder["buildSpine"]>) => {
    captured.spine = await real(...args);
    return captured.spine;
  };
  const actOf = (slotTitle: string): number => {
    const spine = captured.spine;
    if (!spine) throw new Error("spine not built yet");
    const all = spine.acts.flatMap((a) => a.slots.map((s) => s.title));
    if (new Set(all).size !== all.length) throw new Error("stub spine reused a slot title across acts; the join below is unsound");
    const i = spine.acts.findIndex((a) => a.slots.some((s) => s.title === slotTitle));
    if (i < 0) throw new Error(`no act has slot "${slotTitle}"`);
    return i;
  };
  return { builder, captured, actOf };
}

function stubDeps() {
  return {
    understander: new StubPromptUnderstander(),
    researcher: new StubExternalResearcher(),
    deepenBuilder: new StubDeepenActBuilder(),
    narrationVerifier: new StubNarrationVerifierBuilder(),
    continuityBuilder: new StubContinuityBuilder(),
    finalize: fakeFinalize()
  };
}

const readyActIndex = (candidate: PartialCandidate): number => candidate.acts.filter((a) => a.status === "ready").length - 1;

describe("runForayPipeline — all acts narrate at once; stitch and continuity stay in act order (G-32)", () => {
  it("requests every act's narration while act 1's is still held, and act 1 is ready while the later acts are still held", async () => {
    /* MUTATION THAT KILLS THIS: restore the serial loop in `runPipeline.ts`
       (await `stage("narrate:i")` inside the stitch loop). No later act's
       slot is requested while act 0 is held. Ran it — red. */
    const spine = capturingSpine();
    const act0 = deferred();
    const later = deferred();
    const { writer, state } = holdingWriter((title) => (spine.actOf(title) === 0 ? act0.promise : later.promise));
    const events: string[] = [];
    let readyAt = 0;

    const startedMs = Date.now();
    const run = runForayPipeline(request, { ...options, narrationActConcurrency: 4 }, {
      ...stubDeps(),
      spineBuilder: spine.builder,
      narrationWriter: writer,
      onActReady: (candidate) => {
        const i = readyActIndex(candidate);
        events.push(`ready:${i}`);
        if (i === 0) readyAt = Date.now();
      }
    });

    await waitFor(() => {
      const s = spine.captured.spine;
      return s !== null && s.acts.every((_a, i) => state.started.some((t) => spine.actOf(t) === i));
    }, "a slot of every act to be requested while act 0 is held");
    expect(state.completed).toHaveLength(0);

    /* Act 0 alone is released; the later acts stay held. Act 0 must become
       listenable anyway (F-66's property, kept). */
    act0.resolve();
    await waitFor(() => events.includes("ready:0"), "act 0 to be ready while later acts are still held");
    expect(state.completed.every((t) => spine.actOf(t) === 0)).toBe(true);
    expect(events).toEqual(["ready:0"]);

    await settle(40);
    later.resolve();
    const out = await run;
    const totalMs = Date.now() - startedMs;

    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    const actCount = spine.captured.spine!.acts.length;
    expect(actCount).toBeGreaterThan(1);
    expect(events).toEqual(Array.from({ length: actCount }, (_, i) => `ready:${i}`));

    /* ttlA1Ms is still act 0's clock: read at act 0's `onActReady`, before
       the later acts were released, so it is at most the ready instant and at
       least 40 ms short of the run. */
    expect(out.ttlA1Ms).not.toBeNull();
    expect(out.ttlA1Ms!).toBeLessThanOrEqual(readyAt - startedMs);
    expect(totalMs - out.ttlA1Ms!).toBeGreaterThanOrEqual(40);
  });

  it("continuity for act N runs after act N-1 is stitched, in boundary order, even when act 1 finishes last", async () => {
    /* Act 0 is held until every later act has finished narrating, so
       completion order is the reverse of act order. §4.8 must still smooth
       boundary 0→1, then 1→2, then 2→3, each after the previous act's items
       exist — `ForayStitcher`'s contract.

       MUTATION THAT KILLS THIS: stitch each act inside its own narration
       promise (`narrations[i].then(a => stitcher.stitchNextAct(a))`) so acts
       are stitched in completion order. The continuity log then opens with a
       later boundary, or the stitcher pairs act 3's narration with act 0's
       deepened act. Ran it — red. */
    const spine = capturingSpine();
    const act0 = deferred();
    const { writer, state } = holdingWriter((title) => (spine.actOf(title) === 0 ? act0.promise : undefined));

    const continuity = new StubContinuityBuilder();
    const realSmooth = continuity.smoothSeam.bind(continuity);
    const log: string[] = [];
    const itemsSoFar: Record<number, string[]> = {};
    continuity.smoothSeam = async (...args: Parameters<ContinuityBuilder["smoothSeam"]>) => {
      log.push(`smooth:${args[0].previousActTitle}->${args[0].nextActTitle}`);
      return realSmooth(...args);
    };

    const run = runForayPipeline(request, { ...options, narrationActConcurrency: 4 }, {
      ...stubDeps(),
      spineBuilder: spine.builder,
      narrationWriter: writer,
      continuityBuilder: continuity,
      onActReady: (candidate) => {
        const i = readyActIndex(candidate);
        log.push(`ready:${i}`);
        itemsSoFar[i] = candidate.items.map((item) => (item.type === "segment" ? item.segment_id : (item.id ?? item.type)));
      }
    });

    await waitFor(() => {
      const s = spine.captured.spine;
      return s !== null && s.acts.slice(1).every((a) => a.slots.every((slot) => state.completed.includes(slot.title)));
    }, "every later act to finish narrating while act 0 is held");
    expect(log).toEqual([]);
    act0.resolve();

    const out = await run;
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;
    const acts = out.spine.acts;
    expect(acts.length).toBeGreaterThan(2);

    /* Boundaries in order, each smoothed strictly after the previous act
       was ready — never before, never out of order. */
    const expected: string[] = ["ready:0"];
    for (let i = 1; i < acts.length; i++) expected.push(`smooth:${acts[i - 1]!.title}->${acts[i]!.title}`, `ready:${i}`);
    expect(log).toEqual(expected);

    /* And act N's partial is act N-1's partial plus act N's items. */
    for (let i = 1; i < acts.length; i++) {
      const previous = itemsSoFar[i - 1]!;
      expect(itemsSoFar[i]!.slice(0, previous.length)).toEqual(previous);
      expect(itemsSoFar[i]!.length).toBeGreaterThan(previous.length);
      expect(itemsSoFar[i]).toContain(`act-${i + 1}-introduction`);
    }
  });

  it("writes exactly the checkpoint keys the serial pipeline wrote, in the same per-act order", async () => {
    /* MUTATION THAT KILLS THIS: key the act as `narrate:${i}:act`, or save
       `narrate:i` before its slots. The key set (or the save order) differs.
       Ran it — red. */
    const spine = capturingSpine();
    const key = "g-32-keys";
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration, topic: options.topic }));

    const out = await runForayPipeline(
      request,
      { ...options, checkpointKey: key, narrationActConcurrency: 4 },
      { ...stubDeps(), spineBuilder: spine.builder, narrationWriter: new StubNarrationWriterBuilder(), checkpoint: store }
    );
    expect(out.outcome).toBe("generated");

    const s = spine.captured.spine!;
    const expected = new Set<string>(["understand", "research-shape", "spine", "source"]);
    s.acts.forEach((a, i) => {
      expected.add(`deepen:${i}`);
      a.slots.forEach((_slot, j) => expected.add(`narrate:${i}:${j}`));
      expected.add(`narrate:${i}`);
      expected.add(`stitch:${i}`);
    });
    expect(new Set(store.stageKeys(key))).toEqual(expected);

    const saves = store.saves.map((x) => x.stage);
    const at = (stage: string) => {
      const i = saves.indexOf(stage);
      expect(i, stage).toBeGreaterThanOrEqual(0);
      return i;
    };
    s.acts.forEach((a, i) => {
      a.slots.forEach((_slot, j) => expect(at(`narrate:${i}:${j}`)).toBeLessThan(at(`narrate:${i}`)));
      expect(at(`narrate:${i}`)).toBeLessThan(at(`stitch:${i}`));
      if (i > 0) expect(at(`stitch:${i - 1}`)).toBeLessThan(at(`stitch:${i}`));
    });
  });

  it("resumes a crashed run by narrating only the acts that never landed", async () => {
    /* Run 1: act 2's slots fail; acts 0, 1 and 3 are in flight beside it and
       finish, so their `narrate:<i>` keys are banked — and so are
       `stitch:0`/`stitch:1`, which act 2's failure does not reach. Run 2 pays
       for act 2's slots, then smooths the two boundaries that were never
       stitched, and nothing else.

       MUTATION THAT KILLS THIS: drop the `resume` hook from the per-act
       `writeNarration` call (or key the resume by `_actIndex` instead of
       `i`). Run 2 then writes every slot of every act. Ran it — red. */
    const spine = capturingSpine();
    const key = "g-32-resume";
    const store = new FakeCheckpointStore(checkpointFingerprint({ prompt: request.prompt, duration: request.duration, topic: options.topic }));

    const { writer, state } = holdingWriter();
    const real = writer.writePages;
    writer.writePages = async (...args) => {
      if (spine.actOf(args[0].slotTitle) === 2) {
        state.started.push(args[0].slotTitle);
        await settle(10);
        throw new Error("provider went away mid-slot");
      }
      return real(...args);
    };

    await expect(
      runForayPipeline(
        request,
        { ...options, checkpointKey: key, narrationActConcurrency: 4 },
        { ...stubDeps(), spineBuilder: spine.builder, narrationWriter: writer, checkpoint: store }
      )
    ).rejects.toThrow(/provider went away/);

    const s = spine.captured.spine!;
    expect(s.acts.length).toBe(4);
    const banked = store.stageKeys(key);
    expect(banked.filter((k) => /^narrate:\d+$/.test(k)).sort()).toEqual(["narrate:0", "narrate:1", "narrate:3"]);
    expect(banked.filter((k) => /^stitch:\d+$/.test(k)).sort()).toEqual(["stitch:0", "stitch:1"]);
    /* Every act was started — the failure of one did not wait on the others. */
    expect(new Set(state.started.map((t) => spine.actOf(t)))).toEqual(new Set([0, 1, 2, 3]));

    const second = holdingWriter();
    const continuity = new StubContinuityBuilder();
    const realSmooth = continuity.smoothSeam.bind(continuity);
    let smoothCalls = 0;
    continuity.smoothSeam = async (...args: Parameters<ContinuityBuilder["smoothSeam"]>) => {
      smoothCalls++;
      return realSmooth(...args);
    };
    let spineCalls = 0;
    const spineBuilder = new StubSpineBuilder();
    spineBuilder.buildSpine = async () => {
      spineCalls++;
      throw new Error("the spine is on the checkpoint; this must not be called");
    };

    const out = await runForayPipeline(
      request,
      { ...options, checkpointKey: key, narrationActConcurrency: 4 },
      { ...stubDeps(), spineBuilder, narrationWriter: second.writer, continuityBuilder: continuity, checkpoint: store }
    );
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;

    expect(spineCalls).toBe(0);
    expect(second.state.started.map((t) => spine.actOf(t))).toEqual(s.acts[2]!.slots.map(() => 2));
    expect(second.state.started).toHaveLength(s.acts[2]!.slots.length);
    expect(smoothCalls).toBe(2);
    expect(store.stageKeys(key).filter((k) => /^(narrate|stitch):\d+$/.test(k))).toHaveLength(8);
    /* The resumed acts are reported as resumed, the rebuilt one as timed. */
    expect(out.narration.acts.map((a) => [a.act, a.resumed === true])).toEqual([
      [0, true],
      [1, true],
      [2, false],
      [3, true]
    ]);
  });

  /** Runs the pipeline with every slot held, waits until exactly
   * `expectedPeakActs` acts are in flight, checks it stays there, releases,
   * and returns the run's outcome plus the writer's timeline. */
  async function runAtCap(cap: 1 | 4, expectedPeakActs: number) {
    const spine = capturingSpine();
    const all = deferred();
    const { writer, state } = holdingWriter(() => all.promise);
    const run = runForayPipeline(request, { ...options, narrationActConcurrency: cap }, {
      ...stubDeps(),
      spineBuilder: spine.builder,
      narrationWriter: writer
    });
    run.catch(() => undefined);

    const actsInFlight = () => new Set(state.started.filter((t) => !state.completed.includes(t)).map((t) => spine.actOf(t))).size;
    await waitFor(() => spine.captured.spine !== null && actsInFlight() === expectedPeakActs, `${expectedPeakActs} act(s) in flight at cap ${cap}`);
    await settle();
    expect(actsInFlight()).toBe(expectedPeakActs);
    all.resolve();

    const out = await run;
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") throw new Error("not generated");
    expect(out.narration.concurrency).toBe(cap);
    return { out, state, spine };
  }

  it("honours the concurrency cap through the pipeline: at 1 the acts run in series", async () => {
    /* MUTATION THAT KILLS THIS: pass `sourced.acts.length` to `createActGate`
       instead of the option. Two acts are in flight at once. Ran it — red. */
    const { out, state, spine } = await runAtCap(1, 1);
    /* Series: on one timeline, every slot of act i-1 is DONE before the
       first slot of act i STARTS. */
    const actOfEvent = (e: string) => spine.actOf(e.slice(e.indexOf(":") + 1));
    for (let i = 1; i < out.spine.acts.length; i++) {
      const firstStart = state.timeline.findIndex((e) => e.startsWith("start:") && actOfEvent(e) === i);
      const lastDone = state.timeline.map((e, k) => (e.startsWith("done:") && actOfEvent(e) === i - 1 ? k : -1)).reduce((a, b) => Math.max(a, b), -1);
      expect(firstStart).toBeGreaterThanOrEqual(0);
      expect(lastDone).toBeGreaterThanOrEqual(0);
      expect(lastDone).toBeLessThan(firstStart);
    }
  });

  it("honours the concurrency cap through the pipeline: at 4 every act of a medium Foray is in flight at once", async () => {
    /* MUTATION THAT KILLS THIS: `createActGate(1)` regardless of the option
       (the serial pipeline). Only one act is ever in flight. Ran it — red. */
    const { out } = await runAtCap(4, 4);
    expect(out.spine.acts).toHaveLength(4);
  });

  it("reports the cap and one narration timing per act, whose intervals overlap", async () => {
    /* MUTATION THAT KILLS THIS: build `narrationActs` from `stitch:` timings,
       or drop the sort — the act indices or the overlap below are wrong.
       Ran it — red. */
    const spine = capturingSpine();
    const all = deferred();
    const { writer } = holdingWriter(() => all.promise);
    const run = runForayPipeline(request, { ...options, narrationActConcurrency: 4 }, {
      ...stubDeps(),
      spineBuilder: spine.builder,
      narrationWriter: writer
    });
    await waitFor(() => spine.captured.spine !== null, "the spine");
    await settle(30);
    all.resolve();
    const out = await run;
    expect(out.outcome).toBe("generated");
    if (out.outcome !== "generated") return;

    const n = out.spine.acts.length;
    expect(out.narration.concurrency).toBe(4);
    expect(out.narration.acts.map((a) => a.act)).toEqual(Array.from({ length: n }, (_, i) => i));
    for (const a of out.narration.acts) {
      expect(a.resumed).toBeUndefined();
      expect(a.ms).toBeGreaterThanOrEqual(25);
      expect(Number.isNaN(Date.parse(a.startedAt))).toBe(false);
    }
    /* Overlap, from the report's own numbers: every act started before act 0
       finished. This is the row a reader of `report.json` checks. */
    const start = (a: { startedAt: string }) => Date.parse(a.startedAt);
    const end0 = start(out.narration.acts[0]!) + out.narration.acts[0]!.ms;
    for (const a of out.narration.acts.slice(1)) expect(start(a)).toBeLessThanOrEqual(end0);
    /* The same rows are in `timings` under their stage names — one source. */
    expect(out.timings.filter((t) => /^narrate:\d+$/.test(t.name))).toHaveLength(n);
  });
});
