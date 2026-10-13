import { describe, it, expect } from "vitest";
import { writeNarration, allWrittenNarration, type NarrationWriteStats, type SeamCheckedEvent, type WrittenAct } from "../src/generation/writeNarration";
import {
  DEFAULT_WRITER_STREAM_IDLE_MS,
  UNFINISHED_AT_CAP_NOTE,
  drainWriterStream,
  writeActNarration,
  type SeamVerifyRequest,
  type SeamVerifyResult,
  type WriteActOptions
} from "../src/generation/writeAct";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { stitchAct } from "../src/generation/stitchAct";
import { buildVeracityMetrics } from "../src/generation/veracityMetrics";
import { tapeDocIdFor } from "../src/types/narration";
import type { EvidenceBeat, EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type { ActWriteRequest, ActWriteResult, NarrationBuildContext, WriterStreamEvent, WrittenSeam } from "../src/generation/NarrationWriterBuilder";
import type { ActVerifyRequest, ActVerifyResult } from "../src/generation/NarrationVerifierBuilder";
import type { SourcedAct, TapePointer } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";

/**
 * GV-73 (W4-10, docs/roadmap/generation-v2.md; R1-06, R1-01, GP-05): the
 * streamed act writer. Every case is offline: the stub writer's own
 * `writeActStream` on a fake clock, or a scripted stream.
 *
 * Mutations run against this suite (each named where it bites):
 *   1. writeAct.ts streamRound: probe only after the stream has drained
 *      (the release waits for the last seam).
 *   2. writeAct.ts releaseProbe: run the gate on the real seam instead of a
 *      copy (`const scratch = seam`).
 *   3. writeAct.ts mechanicalPass: a released seam keeps `changed = false`
 *      in its release round (the act's verifier never judges it).
 *   4. writeAct.ts mechanicalPass: the `cut && !written` branch removed (a
 *      cut seam gets the missing-seam refusal).
 *   5. writeAct.ts: `askOnly` never set (round 2 re-asks every seam).
 *   6. writeAct.ts freeze step: `if (seam.released) seam.frozen = true`
 *      removed (a refused released seam is sent back for editing).
 *   7. writeAct.ts nextWithin: one timer for the whole stream instead of one
 *      per event (a long healthy stream is cut).
 *   8. writeAct.ts assemble: the carrier is always the seam's first beat
 *      (the moved beats are spoken before the clip).
 *   9. veracityMetrics.ts buildVeracityMetrics: always emit the three
 *      fields (the default report changes).
 *  10. writeAct.ts settleReleased: hand no beat on (a beat a released seam
 *      leaves uncarried is never asked for again).
 */

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
const ctx: NarrationBuildContext = { userId: "founder-1" };

/* ------------------------------------------------------------ fixture */

const SHOW = "Practical AI";
const ITEMS = {
  A: { itemId: "practical-ai--skills-over-models", title: "Skills over models", anchor: "so the first thing to understand is" },
  B: { itemId: "practical-ai--a-robot-in-a-simulator", title: "A robot in a simulator", anchor: "when we put the robot in the simulator" },
  C: { itemId: "practical-ai--the-data-flywheel", title: "The data flywheel", anchor: "the flywheel only turns when" }
} as const;
type Key = keyof typeof ITEMS;
const SEGMENT = (k: Key): string => `${ITEMS[k].itemId}#${k === "A" ? 410 : k === "B" ? 980 : 1500}`;

const WINDOWS: Record<Key, string> = {
  A:
    "Before the break we were talking about hiring, and how long it takes to find people who can maintain a pipeline. " +
    `${ITEMS.A.anchor} that the mix of skills in the organization decides the tools, and the model choice comes last.`,
  B:
    "That was the part of the conversation about tooling, which we will come back to. " +
    `${ITEMS.B.anchor} the first thing that broke was the physics, not the policy, and it took a week of replays to see it.`,
  C:
    "We had been circling the question of where the training data comes from for a while. " +
    `${ITEMS.C.anchor} people use the product enough to leave a trail, and that trail is what the next model learns from.`
};

const NBS: EvidenceDoc = {
  docId: "print:nbs-143",
  kind: "print",
  title: "National Bureau of Standards, Building Science Series 143 (1982)",
  url: "https://nvlpubs.nist.gov/nistpubs/Legacy/BSS/nbsbuildingscience143.pdf",
  text:
    "The box beam-hanger rod connections were not checked for adequacy at any stage of the design. " +
    "The as-built connection could support about sixty percent of the load required by the Kansas City Building Code. " +
    "Investigators traced the change to a shop drawing produced by the fabricator and approved without calculation."
};

const CLAIMS = {
  b0: "The Hyatt walkway hangers carried double the load the design assumed.",
  b1: "The connection was never checked for adequacy at any stage.",
  b2: "Investigators traced the change to a fabricator's shop drawing.",
  b3: "The as-built connection could carry about sixty percent of the code load."
};

function pointer(k: Key, startSec: number): TapePointer {
  return { segmentId: SEGMENT(k), itemId: ITEMS[k].itemId, startSec, endSec: startSec + 120, startAnchor: ITEMS[k].anchor, endAnchor: "and that", tier: 1, confidence: "high" };
}
function narration(claim: string) {
  return { sourcing: "narration" as const, claim, exploration: false, narration: { mode: "Patch" as const, reason: "t" } };
}
function tape(claim: string, k: Key) {
  return { sourcing: "tape" as const, claim, exploration: false, tape: pointer(k, k === "A" ? 410 : k === "B" ? 980 : 1500) };
}

/** s0 {b0, b1} -> c0 (A); s1 {b3} -> c1 (B); s2 {b5}. Streamed, the first
 * seam's beats move after c0 (`introOnlyFirstSeam`). */
function fourBeatsTwoClips(): SourcedAct {
  return {
    title: "Act 1: Skills decide the tools",
    slots: [
      { title: "Opening", beats: [narration(CLAIMS.b0), narration(CLAIMS.b1), tape("A guest explains why skills decide the tools.", "A")] },
      { title: "The turn", beats: [narration(CLAIMS.b2), tape("The robot in the simulator.", "B"), narration(CLAIMS.b3)] }
    ]
  };
}

/** s0 {b0} -> c0 (A); s1 {} -> c1 (B); s2 {b3}. */
function threeClipsIntroOnly(): SourcedAct {
  return {
    title: "Act 2: An intro-only seam",
    slots: [
      { title: "Opening", beats: [narration(CLAIMS.b0), tape("A guest explains why skills decide the tools.", "A"), tape("The robot in the simulator.", "B")] },
      { title: "The turn", beats: [narration(CLAIMS.b3)] }
    ]
  };
}

/** A clip first, so the streamed layout is the classic one: s0 {} -> c0
 * (A); s1 {b1} -> c1 (B); s2 {b3} -> c2 (C); s3 {b5}. Four seams. */
function clipFirst(): SourcedAct {
  return {
    title: "Act 3: The tape opens",
    slots: [
      { title: "Opening", beats: [tape("A guest explains why skills decide the tools.", "A"), narration(CLAIMS.b1), tape("The robot in the simulator.", "B")] },
      { title: "The turn", beats: [narration(CLAIMS.b2), tape("The flywheel.", "C"), narration(CLAIMS.b3)] }
    ]
  };
}

/** The real gatherer's shape. `heldWindows` names the segments whose window
 * the pipeline holds: a clip with no window gets a claim-free introduction
 * from the stub (a question and a listener imperative naming the show), the
 * seam the streamed path can release on code checks alone. */
function gatherer(heldWindows: Key[] = ["B", "C"]): EvidenceGatherer {
  const windowDoc = (p: TapePointer): EvidenceDoc | undefined => {
    const k = (Object.keys(ITEMS) as Key[]).find((key) => SEGMENT(key) === p.segmentId);
    if (!k || !heldWindows.includes(k)) return undefined;
    return { docId: tapeDocIdFor(p.segmentId), kind: "tape", title: `${SHOW} — ${ITEMS[k].title}`, text: WINDOWS[k] };
  };
  return {
    async gather(beat: EvidenceBeat): Promise<EvidencePack> {
      const docs: EvidenceDoc[] = [];
      let tapeContext: EvidencePack["tape"];
      if (beat.tape) {
        const own = windowDoc(beat.tape);
        if (own) docs.push({ ...own, tapePosition: "next" });
        const k = (Object.keys(ITEMS) as Key[]).find((key) => ITEMS[key].itemId === beat.tape!.itemId)!;
        tapeContext = { itemId: beat.tape.itemId, showTitle: SHOW, episodeTitle: ITEMS[k].title, startSec: beat.tape.startSec, endSec: beat.tape.endSec };
      }
      for (const [position, p] of [["previous", beat.adjacentTape?.previous], ["next", beat.adjacentTape?.next]] as const) {
        const w = p ? windowDoc(p) : undefined;
        if (!w || docs.some((d) => d.docId === w.docId)) continue;
        docs.push({ ...w, tapePosition: position });
      }
      if (!beat.tape) docs.push(NBS);
      return { purpose: beat.claim, beatKind: "account", docs, ...(tapeContext ? { tape: tapeContext } : {}) };
    }
  };
}

/** A fake clock the stub's per-seam delay advances, so `atMs` is exact and
 * no test waits in wall time. */
function fakeClock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

/** The stub writer on a fake clock, logging each seam as its line arrives,
 * with hooks to mutate the reply (both paths: the stub's stream writes its
 * seams through `writeAct`) and the verifier's verdict. */
function builders(opts: {
  seamDelayMs?: number;
  mutate?: (reply: ActWriteResult, request: ActWriteRequest, call: number) => ActWriteResult;
  mutateVerdict?: (verdict: ActVerifyResult, request: ActVerifyRequest, call: number) => ActVerifyResult;
} = {}) {
  const clock = fakeClock();
  const log: string[] = [];
  const requests: ActWriteRequest[] = [];
  const replies: ActWriteResult[] = [];
  const verifyRequests: ActVerifyRequest[] = [];
  class LoggingStub extends StubNarrationWriterBuilder {
    override async *writeActStream(request: ActWriteRequest, buildCtx: NarrationBuildContext): AsyncGenerator<WriterStreamEvent> {
      for await (const event of super.writeActStream(request, buildCtx)) {
        if (event.type === "seam") log.push(`arrived ${event.seam.seamId}@${event.atMs}`);
        yield event;
      }
    }
  }
  const writer = new LoggingStub(undefined, { seamDelayMs: opts.seamDelayMs ?? 0, now: clock.now, sleep: clock.sleep });
  const realWrite = writer.writeAct.bind(writer);
  let writes = 0;
  writer.writeAct = async (request, buildCtx) => {
    writes++;
    requests.push(request);
    const real = await realWrite(request, buildCtx);
    const reply = opts.mutate ? opts.mutate(real, request, writes) : real;
    replies.push(reply);
    return reply;
  };
  const verifier = new StubNarrationVerifierBuilder();
  const realVerify = verifier.verifyAct.bind(verifier);
  let verifies = 0;
  verifier.verifyAct = async (request, buildCtx) => {
    verifies++;
    verifyRequests.push(request);
    const verdict = await realVerify(request, buildCtx);
    return opts.mutateVerdict ? opts.mutateVerdict(verdict, request, verifies) : verdict;
  };
  return { writer, verifier, log, requests, replies, verifyRequests };
}

async function writeOne(act: SourcedAct, b: ReturnType<typeof builders>, extra: Partial<WriteActOptions> = {}, heldWindows?: Key[]): Promise<{ act: WrittenAct; stats: NarrationWriteStats; checked: SeamCheckedEvent[] }> {
  const stats: NarrationWriteStats = { retryRounds: 0 };
  const checked: SeamCheckedEvent[] = [];
  const written = await writeActNarration(
    act,
    {
      writer: b.writer,
      verifier: b.verifier,
      evidence: gatherer(heldWindows),
      stats,
      onSeamChecked: (event) => {
        checked.push(event);
        b.log.push(`checked ${event.seamId}`);
      },
      ...extra
    },
    voice,
    ctx
  );
  return { act: written, stats, checked };
}

/** The filler the drop-a-beat mutation swaps in (actNarration.test.ts's). */
const FILLER = "That thread runs further than most listeners expect, and the people closest to it saw it very differently at the time.";

/* ------------------------------------------------------------ release */

describe("GV-73 — the streamed act writer releases a code-checked introduction as its line closes", () => {
  it("fires onSeamChecked for s0 before the stream's last seam arrives, and s0 carries no claim", async () => {
    /* MUTATION 1 (probe only after the stream drained) kills this: "checked
       s0" then follows "arrived s2". */
    const b = builders({ seamDelayMs: 1000 });
    const { act, stats, checked } = await writeOne(fourBeatsTwoClips(), b, { streamSeams: true, actIndex: 2 });

    expect(b.log.slice(0, 4)).toEqual(["arrived s0@1000", "checked s0", "arrived s1@2000", "arrived s2@3000"]);
    expect(checked).toEqual([{ actIndex: 2, seamId: "s0", script: expect.any(String), verifiedBy: "code", clipId: "c0", atMs: 1000 }]);
    expect(stats).toMatchObject({ seamsReleasedEarly: 1, releasedThenRefused: 0, firstSeamCheckedMs: 1000 });

    /* Line 1 is the introduction alone: the reply's s0 has no claim, and its
       page (the clip's connective narration) cites nothing. */
    expect(b.replies[0]!.seams.find((s) => s.seamId === "s0")!.claims).toEqual([]);
    expect(b.requests[0]!.seams[0]!.beats).toEqual([]);
    const clipBeat = act.slots[0]!.beats[2]!;
    expect(clipBeat.sourcing === "tape" && clipBeat.connectiveNarration?.script).toBe(checked[0]!.script);
    expect(clipBeat.sourcing === "tape" && clipBeat.connectiveNarration?.sources).toEqual([]);
    expect(clipBeat.sourcing === "tape" && clipBeat.connectiveNarration?.verified).toBe(true);
  });

  it("the streamed and one-shot paths write the same act from the same writer output (a clip-first act, with a round-1 mechanical refusal)", async () => {
    /* MUTATION 2 (gate the real seam, not a copy) kills this: s2's refused
       round-1 attempt is recorded twice on the streamed side. MUTATION 3
       (released seam not judged with the act) kills it too: s0 is never
       confirmed and its introduction is dropped. */
    const mutate = (reply: ActWriteResult, _request: ActWriteRequest, call: number): ActWriteResult =>
      call === 1 ? { seams: reply.seams.map((s) => (s.seamId === "s2" ? { ...s, script: "" } : s)) } : reply;
    const streamed = await writeOne(clipFirst(), builders({ seamDelayMs: 5, mutate }), { streamSeams: true }, ["B", "C"]);
    const oneShot = await writeOne(clipFirst(), builders({ mutate }), {}, ["B", "C"]);

    expect(streamed.checked.map((e) => e.seamId)).toEqual(["s0"]);
    expect(oneShot.checked).toEqual([]);
    expect(streamed.stats.retryRounds).toBe(1);
    expect(streamed.act).toEqual(oneShot.act);
  });

  it("a released seam never reappears in a later round's edit list, and releasedThenRefused is 0 across the fixtures", async () => {
    /* MUTATION 6 (a released seam not frozen after its round) kills the
       first half when the verifier refuses it (next test); here: the
       drop-a-beat mutation forces three rounds, and s0 is frozen in both
       retries. */
    const dropB3 = (reply: ActWriteResult): ActWriteResult => ({
      seams: reply.seams.map((s) => {
        if (s.seamId !== "s1") return s;
        const claims = s.claims.filter((c) => c.claimText !== CLAIMS.b2);
        return { ...s, script: s.script.replace(/[^.]*investigators traced[^.]*\./i, FILLER), claims, usedClaims: claims.map((_, i) => i) };
      })
    });
    const b = builders({ mutate: dropB3 });
    const { stats } = await writeOne(fourBeatsTwoClips(), b, { streamSeams: true }, ["B"]);
    expect(b.requests).toHaveLength(3);
    for (const request of b.requests.slice(1)) {
      const s0 = request.seams.find((s) => s.seamId === "s0")!;
      expect(s0.frozen).toBe(true);
      expect(s0.notes).toBeUndefined();
    }
    expect(stats.releasedThenRefused).toBe(0);

    for (const [act, held] of [
      [fourBeatsTwoClips(), ["B"]],
      [threeClipsIntroOnly(), ["B"]],
      [clipFirst(), ["B", "C"]]
    ] as Array<[SourcedAct, Key[]]>) {
      const run = await writeOne(act, builders(), { streamSeams: true }, held);
      expect(run.stats.releasedThenRefused, act.title).toBe(0);
      expect(run.stats.seamsReleasedEarly, act.title).toBe(1);
    }
  });

  it("a released seam the act's verifier refuses is counted, not edited, and its page is kept out of later rounds", async () => {
    /* MUTATION 6 kills this: s0 goes back to the writer unfrozen, with the
       refusal as its note. */
    const refuseS0 = (verdict: ActVerifyResult, _request: ActVerifyRequest, call: number): ActVerifyResult =>
      call === 1 ? { ...verdict, seams: verdict.seams.map((s) => (s.seamId === "s0" ? { ...s, claimsSupported: false, notes: "refused for the test" } : s)) } : verdict;
    const dropB3 = (reply: ActWriteResult): ActWriteResult => ({
      seams: reply.seams.map((s) => (s.seamId === "s1" ? { ...s, script: s.script.replace(/[^.]*investigators traced[^.]*\./i, FILLER), claims: s.claims.filter((c) => c.claimText !== CLAIMS.b2) } : s))
    });
    const b = builders({ mutate: dropB3, mutateVerdict: refuseS0 });
    const { stats } = await writeOne(fourBeatsTwoClips(), b, { streamSeams: true }, ["B"]);
    expect(stats.releasedThenRefused).toBe(1);
    expect(b.requests.length).toBeGreaterThan(1);
    for (const request of b.requests.slice(1)) expect(request.seams.find((s) => s.seamId === "s0")).toMatchObject({ frozen: true });
    /* The refusal is no note for the writer: only the missing beat is. */
    expect(b.requests[1]!.retryNote).not.toContain("refused for the test");
  });

  it("a claim-bearing seam is released only when the verifier's optional verifySeam confirms it", async () => {
    const b = builders();
    const asked: SeamVerifyRequest[] = [];
    const verifier = Object.assign(b.verifier, {
      verifySeam: async (request: SeamVerifyRequest): Promise<SeamVerifyResult> => {
        asked.push(request);
        return { confirmed: request.seam.seamId === "s1" };
      }
    });
    const { checked, stats } = await writeOne(fourBeatsTwoClips(), { ...b, verifier }, { streamSeams: true }, ["B"]);
    expect(asked.map((r) => r.seam.seamId)).toEqual(["s1", "s2"]);
    /* s1's sources so far: c1's window and s1's own gated claims; not s2's. */
    expect(asked[0]!.sources.every((s) => s.selectedBy === undefined || s.selectedBy === "s1")).toBe(true);
    expect(checked.map((e) => [e.seamId, e.verifiedBy])).toEqual([
      ["s0", "code"],
      ["s1", "verifier"]
    ]);
    expect(stats.seamsReleasedEarly).toBe(2);
    expect(stats.releasedThenRefused).toBe(0);
  });

  it("a beat a released seam leaves uncarried is handed to the next open seam, which the retry asks for it", async () => {
    /* MUTATION 10 (settleReleased hands nothing on) kills this: b3 stays on
       the frozen s1, no note asks for it, and the act stops after round 1. */
    const dropB3 = (reply: ActWriteResult): ActWriteResult => ({
      seams: reply.seams.map((s) => (s.seamId === "s1" ? { ...s, script: s.script.replace(/[^.]*investigators traced[^.]*\./i, FILLER), claims: s.claims.filter((c) => c.claimText !== CLAIMS.b2) } : s))
    });
    const b = builders({ mutate: dropB3 });
    const verifier = Object.assign(b.verifier, { verifySeam: async (request: SeamVerifyRequest): Promise<SeamVerifyResult> => ({ confirmed: request.seam.seamId === "s1" }) });
    const { checked, stats } = await writeOne(fourBeatsTwoClips(), { ...b, verifier }, { streamSeams: true }, ["B"]);
    expect(checked.map((e) => e.seamId)).toEqual(["s0", "s1"]);
    expect(stats.releasedThenRefused).toBe(0);
    expect(b.requests.length).toBeGreaterThan(1);
    const retry = b.requests[1]!;
    expect(retry.seams.find((s) => s.seamId === "s1")).toMatchObject({ frozen: true });
    expect(retry.seams.find((s) => s.seamId === "s2")!.notes).toMatch(/does not carry beat b3/);
  });

  it("writeNarration threads onSeamChecked with each act's index, and nothing streams without the flag", async () => {
    const b = builders();
    const checked: SeamCheckedEvent[] = [];
    await writeNarration([clipFirst(), fourBeatsTwoClips()], { writer: b.writer, verifier: b.verifier, evidence: gatherer(["B"]), streamSeams: true, onSeamChecked: (e) => checked.push(e) }, voice, ctx);
    expect(checked.map((e) => [e.actIndex, e.seamId]).sort()).toEqual([
      [0, "s0"],
      [1, "s0"]
    ]);
    expect(b.log.some((l) => l.startsWith("arrived"))).toBe(true);

    const classic = builders();
    const off: SeamCheckedEvent[] = [];
    const stats: NarrationWriteStats = { retryRounds: 0 };
    await writeNarration([fourBeatsTwoClips()], { writer: classic.writer, verifier: classic.verifier, evidence: gatherer(["B"]), stats, onSeamChecked: (e) => off.push(e) }, voice, ctx);
    expect(off).toEqual([]);
    expect(classic.log).toEqual([]);
    expect(stats).toEqual({ retryRounds: 0 });
  });
});

/* ------------------------------------------------------------ placement */

describe("GV-73 — the moved beats are spoken after the first clip", () => {
  it("a seam with beats after the clip carries the moved beats on its own first beat (case A)", async () => {
    /* MUTATION 8 (carrier = the seam's first beat) kills this: the s1 page
       lands on b0, before c0, and stitchAct plays it first. */
    const { act } = await writeOne(fourBeatsTwoClips(), builders(), { streamSeams: true }, ["B"]);
    const [b0, b1] = act.slots[0]!.beats;
    expect(b0!.sourcing === "narration" && b0!.narration).toBeUndefined();
    expect(b0!.sourcing === "narration" && b0!.carriedBy).toEqual({ slot: 1, beat: 0 });
    expect(b1!.sourcing === "narration" && b1!.carriedBy).toEqual({ slot: 1, beat: 0 });
    const kinds = stitchAct(act, "a0").items.map((item) => item.kind);
    expect(kinds.slice(0, 3)).toEqual(["narration", "tape", "narration"]);
  });

  it("a beatless seam into the next clip carries them as that clip's connective narration (case B)", async () => {
    const { act } = await writeOne(threeClipsIntroOnly(), builders(), { streamSeams: true }, ["B"]);
    const [b0, clipA, clipB] = act.slots[0]!.beats;
    expect(b0!.sourcing === "narration" && b0!.carriedBy).toEqual({ slot: 0, beat: 2 });
    expect(clipA!.sourcing === "tape" && clipA!.connectiveNarration).toBeDefined();
    expect(clipB!.sourcing === "tape" && clipB!.connectiveNarration?.script).toContain("carries the idea that the Hyatt walkway");
    const kinds = stitchAct(act, "a0").items.map((item) => item.kind);
    expect(kinds).toEqual(["narration", "tape", "narration", "tape", "narration"]);
  });
});

/* ------------------------------------------------------------ the cut */

/** A scripted writer: round 1's stream stops at the cap after `finished`
 * seams; every later round streams what it is asked for. The seams are the
 * stub's own, so the gate and the verifier pass them. */
function cappedWriter(finished: number, stop: "length" | "stall" = "length") {
  const stub = new StubNarrationWriterBuilder();
  const requests: ActWriteRequest[] = [];
  const writer = {
    providerName: "scripted",
    writeAct: (request: ActWriteRequest, buildCtx: NarrationBuildContext) => stub.writeAct(request, buildCtx),
    async *writeActStream(request: ActWriteRequest, buildCtx: NarrationBuildContext): AsyncGenerator<WriterStreamEvent> {
      requests.push(request);
      const { seams } = await stub.writeAct(request, buildCtx);
      if (requests.length === 1) {
        for (const seam of seams.slice(0, finished)) yield { type: "seam", seam, atMs: 0 };
        if (stop === "stall") await new Promise<never>(() => undefined);
        yield { type: "end", stopReason: "length", unfinishedSeamIds: seams.slice(finished).map((s) => s.seamId) };
        return;
      }
      for (const seam of seams) yield { type: "seam", seam, atMs: 0 };
      yield { type: "end", stopReason: "end", unfinishedSeamIds: [] };
    }
  };
  return { writer, requests };
}

describe("GV-73 — a token-cap cut keeps the finished seams", () => {
  it("stopReason 'length' after 2 of 4 seams keeps both drafts, and round 2 asks only for the 2 unfinished seams", async () => {
    /* MUTATION 4 (no cut branch) kills the note; MUTATION 5 (askOnly never
       set) kills the round-2 request. */
    const { writer, requests } = cappedWriter(2);
    const stats: NarrationWriteStats = { retryRounds: 0 };
    const act = await writeActNarration(clipFirst(), { writer, verifier: new StubNarrationVerifierBuilder(), evidence: gatherer(["A", "B", "C"]), stats, streamSeams: true }, voice, ctx);

    expect(requests).toHaveLength(2);
    expect(requests[0]!.seams.map((s) => s.seamId)).toEqual(["s0", "s1", "s2", "s3"]);
    expect(requests[1]!.seams.map((s) => s.seamId)).toEqual(["s2", "s3"]);
    expect(requests[1]!.retryNote).toContain(UNFINISHED_AT_CAP_NOTE);
    expect(stats.retryRounds).toBe(1);

    const pages = allWrittenNarration([act]);
    expect(pages).toHaveLength(4);
    expect(pages.every((p) => p.verified)).toBe(true);
    /* s0 and s1 were kept from round 1 (one attempt each); s2 and s3 carry
       the cap's refusal, then their round-2 confirmation. */
    expect(pages.map((p) => p.attempts?.length)).toEqual([1, 1, 2, 2]);
    expect(pages[2]!.attempts![0]).toMatchObject({ attempt: 1, rejected: true, rejectionNote: UNFINISHED_AT_CAP_NOTE });
  });

  it("a stalled stream is cut on the idle bound like a cap, and a long healthy stream is not cut", async () => {
    /* MUTATION 7 (one timer for the whole stream) kills the second half. */
    const { writer, requests } = cappedWriter(2, "stall");
    const act = await writeActNarration(clipFirst(), { writer, verifier: new StubNarrationVerifierBuilder(), evidence: gatherer(["A", "B", "C"]), streamSeams: true, streamIdleTimeoutMs: 30 }, voice, ctx);
    expect(requests[1]!.seams.map((s) => s.seamId)).toEqual(["s2", "s3"]);
    expect(requests[1]!.retryNote).toMatch(/stream stalled \(nothing arrived for 30 ms\)/);
    expect(allWrittenNarration([act])).toHaveLength(4);

    const seam: WrittenSeam = { seamId: "s0", script: "x", claims: [], usedClaims: [], pronunciationHints: [] };
    async function* slow(): AsyncGenerator<WriterStreamEvent> {
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 15));
        yield { type: "seam", seam: { ...seam, seamId: `s${i}` }, atMs: i };
      }
      yield { type: "end", stopReason: "end", unfinishedSeamIds: [] };
    }
    const got: string[] = [];
    const drained = await drainWriterStream(slow(), 50, (s) => got.push(s.seamId));
    expect(drained.stopReason).toBe("end");
    expect(got).toHaveLength(6);
    expect(DEFAULT_WRITER_STREAM_IDLE_MS).toBe(120_000);
  });

  it("a stream that ends without its 'end' event, or yields after it, throws rather than passing a short act", async () => {
    const seam: WrittenSeam = { seamId: "s0", script: "x", claims: [], usedClaims: [], pronunciationHints: [] };
    async function* noEnd(): AsyncGenerator<WriterStreamEvent> {
      yield { type: "seam", seam, atMs: 0 };
    }
    async function* afterEnd(): AsyncGenerator<WriterStreamEvent> {
      yield { type: "end", stopReason: "end", unfinishedSeamIds: [] };
      yield { type: "seam", seam, atMs: 0 };
    }
    await expect(drainWriterStream(noEnd(), 1000, () => undefined)).rejects.toThrow(/without an 'end' event/);
    await expect(drainWriterStream(afterEnd(), 1000, () => undefined)).rejects.toThrow(/after its 'end' event/);
  });
});

/* ------------------------------------------------------------ metrics */

describe("GV-73 — the streamed counts reach report.json only when the path ran", () => {
  it("buildVeracityMetrics carries seamsReleasedEarly, releasedThenRefused and firstSeamCheckedMs when given, and nothing otherwise", () => {
    /* MUTATION 9 (always emit the fields) kills the first expectation. */
    const base = { sourcedActs: [], writtenActs: [], topic: "t", writerCalls: 1, verifierCalls: 1, pipelineTokens: 0, stageTimings: [] };
    const plain = buildVeracityMetrics(base);
    expect("seamsReleasedEarly" in plain || "releasedThenRefused" in plain || "firstSeamCheckedMs" in plain).toBe(false);
    expect(buildVeracityMetrics({ ...base, seamsReleasedEarly: 3, releasedThenRefused: 0, firstSeamCheckedMs: 7000 })).toMatchObject({ seamsReleasedEarly: 3, releasedThenRefused: 0, firstSeamCheckedMs: 7000 });
    expect(buildVeracityMetrics({ ...base, seamsReleasedEarly: 0 })).toMatchObject({ seamsReleasedEarly: 0, releasedThenRefused: 0, firstSeamCheckedMs: null });
  });
});
