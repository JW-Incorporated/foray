import { afterEach, describe, expect, it } from "vitest";
import {
  CRITIQUE_FLAG_P,
  CRITIQUE_SOURCE_BUDGET_CHARS,
  SelfCritiquingNarrationWriter,
  __swapDraftCriticForTests,
  addSelfCritique,
  createDraftCritic,
  joinCheckpointVariant,
  readSelfCritique,
  registerDraftCritic,
  selfCritiqueLever,
  seamCritiqueSources,
  type SelfCritiqueMode
} from "../src/generation/selfCritique";
import { createNarrationWriterBuilder } from "../src/generation/createNarrationWriterBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { writeActNarration } from "../src/generation/writeAct";
import { allWrittenNarration, type NarrationWriteStats } from "../src/generation/writeNarration";
import { RoutingConfigError } from "../src/config/stageRouting";
import { FlagValueError } from "../src/generation/generationFlags";
import { tapeDocIdFor, validateNarratedBeat, type NarratedBeat } from "../src/types/narration";
import type { EvidenceBeat, EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type {
  ActWriteRequest,
  ActWriteResult,
  NarrationBuildContext,
  NarrationWriterBuilder,
  SeamEditRequest,
  WriterObservation,
  WriterStreamEvent,
  WrittenSeam
} from "../src/generation/NarrationWriterBuilder";
import type { ActVerifyRequest } from "../src/generation/NarrationVerifierBuilder";
import type { SourcedAct, TapePointer } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";
import { FakeDraftCritic } from "./helpers/fakeDraftCritic";

/**
 * GV-94 (W7-08, R2-17 step 3; docs/roadmap/generation-v2.md): the typed
 * self-critique decorator over the act writer. Offline: the critic is the
 * scripted FakeDraftCritic and the writer a scripted fake or the Stub. Every
 * test names the mutation that kills it.
 */

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };

/* ------------------------------------------------------------ fixture */

const WINDOW_A_ID = "tape:seg-a";
const WINDOW_B_ID = "tape:seg-b";
const PRINT_ID = "print:nbs-143";
const WINDOW_A = "So the first thing to understand is that the mix of skills decides the tools, and the model comes last.";
const WINDOW_B = "When we put the robot in the simulator, the first thing that broke was the physics, not the policy.";
const PRINT =
  "The box beam-hanger rod connections were not checked for adequacy at any stage of the design. " +
  "Investigators traced the change to a shop drawing produced by the fabricator and approved without calculation.";

const S0_KEEP = "The hanger rods were never checked for adequacy at any stage of the design.";
const S0_BAD = "Everyone on the project knew the walkway would fall within the year.";
const S1_FIRST = "Investigators traced the change to a shop drawing from the fabricator.";
const S1_IMPERATIVE = "Listen for the engineer who signed it.";
const S2_ONLY = "That drawing was approved without a single calculation.";

function request(over: Partial<ActWriteRequest> = {}, windowB = WINDOW_B): ActWriteRequest {
  return {
    actTitle: "Act 2: The drawing",
    voice,
    seams: [
      { seamId: "s0", beats: [{ beatId: "b0", claim: "The rods were never checked.", mode: "Patch", kind: "account" }], introduces: "c0", intro: "full", band: [40, 600] },
      { seamId: "s1", beats: [{ beatId: "b2", claim: "A shop drawing changed the design.", mode: "Patch", kind: "account" }], follows: "c0", introduces: "c1", intro: "full", band: [40, 600] },
      { seamId: "s2", beats: [{ beatId: "b4", claim: "Nobody did the sums.", mode: "Carry", kind: "account" }], follows: "c1", band: [40, 600] }
    ],
    clips: [
      { clipId: "c0", segmentId: "seg-a", itemId: "item-a", show: "Practical AI", title: "Skills over models", docId: WINDOW_A_ID, opening: WINDOW_A, durationSec: 90, intro: "full" },
      { clipId: "c1", segmentId: "seg-b", itemId: "item-b", show: "Practical AI", title: "A robot in a simulator", docId: WINDOW_B_ID, opening: windowB.slice(0, 80), durationSec: 90, intro: "full" }
    ],
    documents: [
      { docId: WINDOW_A_ID, kind: "tape", title: "Practical AI — Skills over models", text: WINDOW_A },
      { docId: PRINT_ID, kind: "print", title: "NBS BSS 143", text: PRINT },
      { docId: WINDOW_B_ID, kind: "tape", title: "Practical AI — A robot in a simulator", text: windowB }
    ],
    ...over
  };
}

const claim = (quote: string, docId = PRINT_ID) => ({ claimText: quote, quote, docId, contested: false });

function draft(): ActWriteResult {
  return {
    seams: [
      { seamId: "s0", script: `${S0_KEEP} ${S0_BAD}`, claims: [claim("were not checked for adequacy at any stage of the design")], usedClaims: [0], pronunciationHints: [] },
      { seamId: "s1", script: `${S1_FIRST} ${S1_IMPERATIVE}`, claims: [claim("Investigators traced the change to a shop drawing")], usedClaims: [0], pronunciationHints: [] },
      { seamId: "s2", script: S2_ONLY, claims: [claim("approved without calculation")], usedClaims: [0], pronunciationHints: [] }
    ]
  };
}

/** A writer that answers from a script of replies (the last repeats) or
 * throws on the step marked `throw`; keeps every request and ctx. */
class ScriptedWriter implements NarrationWriterBuilder {
  readonly providerName = "scripted";
  readonly requests: ActWriteRequest[] = [];
  readonly contexts: NarrationBuildContext[] = [];
  constructor(private readonly replies: Array<ActWriteResult | { throw: string }>) {}
  async writeAct(req: ActWriteRequest, ctx: NarrationBuildContext): Promise<ActWriteResult> {
    this.requests.push(req);
    this.contexts.push(ctx);
    const step = this.replies[Math.min(this.requests.length - 1, this.replies.length - 1)]!;
    if ("throw" in step) throw new Error(step.throw);
    return step;
  }
}

function harness(mode: SelfCritiqueMode, replies: Array<ActWriteResult | { throw: string }>, critic = new FakeDraftCritic()) {
  const inner = new ScriptedWriter(replies);
  const observed: WriterObservation[] = [];
  const writer = new SelfCritiquingNarrationWriter({ inner, critic, mode, now: () => 1000 });
  const ctx = (actIndex?: number): NarrationBuildContext => ({ userId: "founder-1", ...(actIndex !== undefined ? { actIndex } : {}), observe: (e) => observed.push(e) });
  return { inner, critic, writer, observed, ctx };
}

const restores: Array<() => void> = [];
afterEach(() => {
  while (restores.length) restores.pop()!();
});

/* ---------------------------------------------------- the decorator */

describe("GV-94: the self-critique decorator", () => {
  it("mode off: the draft comes back as the inner writer's own object, with no critic question and no observation", async () => {
    /* MUTATION THAT KILLS THIS: drop the `mode === "off"` early return in
       writeAct. Ran it: red (the critic is asked). */
    const d = draft();
    const { inner, critic, writer, observed, ctx } = harness("off", [d]);
    const out = await writer.writeAct(request(), ctx(2));
    expect(out).toBe(d);
    expect(inner.requests).toHaveLength(1);
    expect(critic.calls).toBe(0);
    expect(observed).toEqual([]);
  });

  it("behind-playhead: act 0 (and an unknown act) is never critiqued; act 1 is", async () => {
    /* MUTATION THAT KILLS THIS: compare `ctx.actIndex === 0` without the
       `?? 0` (an unknown act is critiqued), or drop the behind-playhead
       skip. Ran both: red. */
    for (const actIndex of [0, undefined]) {
      const d = draft();
      const { inner, critic, writer, observed, ctx } = harness("behind-playhead", [d]);
      expect(await writer.writeAct(request(), ctx(actIndex))).toBe(d);
      expect(inner.requests).toHaveLength(1);
      expect(critic.calls).toBe(0);
      expect(observed).toEqual([]);
    }
    const { critic, writer, observed, ctx } = harness("behind-playhead", [draft()]);
    await writer.writeAct(request(), ctx(1));
    expect(critic.calls).toBeGreaterThan(0);
    expect(observed).toHaveLength(1);
    /* `all` critiques act 0 too. */
    const all = harness("all", [draft()]);
    await all.writer.writeAct(request(), all.ctx(0));
    expect(all.critic.calls).toBeGreaterThan(0);
  });

  it("a request with retryNote (a verifier round) passes through untouched", async () => {
    /* MUTATION THAT KILLS THIS: drop the `request.retryNote !== undefined`
       check. Ran it: red (round 2 is critiqued and edited). */
    const d = draft();
    const { inner, critic, writer, ctx } = harness("all", [d], new FakeDraftCritic([], 0));
    expect(await writer.writeAct(request({ retryNote: "Round 1 was refused: b2 is not carried." }), ctx(1))).toBe(d);
    expect(inner.requests).toHaveLength(1);
    expect(critic.calls).toBe(0);
  });

  it("no flagged sentence: no edit call, the draft is returned and the observation says so", async () => {
    /* MUTATION THAT KILLS THIS: make the edit call whenever any sentence was
       checked (drop the `flagsBySeam.size === 0` return). Ran it: red (two
       writer calls). The flag rule is strictly p < CRITIQUE_FLAG_P: one
       sentence is answered at exactly the threshold and is NOT flagged.
       MUTATION THAT KILLS THIS TOO: `answer.p < CRITIQUE_FLAG_P` ->
       `answer.p <= CRITIQUE_FLAG_P`. Ran it: red (flagged 1, an edit call). */
    const d = draft();
    const { inner, critic, writer, observed, ctx } = harness("all", [d], new FakeDraftCritic([{ match: S0_BAD, p: CRITIQUE_FLAG_P }]));
    expect(await writer.writeAct(request(), ctx(1))).toBe(d);
    expect(inner.requests).toHaveLength(1);
    /* Five sentences; the imperative asserts nothing and is not asked. */
    expect(critic.questions.map((q) => q.sentence)).toEqual([S0_KEEP, S0_BAD, S1_FIRST, S2_ONLY]);
    expect(observed).toEqual([
      { kind: "self-critique", acts: 1, sentences: 5, flagged: 0, editedSeams: 0, editCalls: 0, editErrors: 0, critiqueCalls: 4, critiqueErrors: 0, ms: 0, pValues: [0.9, CRITIQUE_FLAG_P, 0.9, 0.9] }
    ]);
  });

  it("one flagged sentence: exactly one edit call, that seam re-sent with the sentence quoted, every other seam frozen, and frozen seams keep their draft script and claims", async () => {
    /* MUTATION THAT KILLS THIS: merge every seam from the edit reply (drop
       the flagged-only merge), or send the other seams unfrozen. Ran both:
       red (s1/s2 take the edit's text; s1 is not frozen). The flagged
       sentence is answered just under the threshold (CRITIQUE_FLAG_P - 0.01).
       MUTATION THAT KILLS THIS TOO: lower the threshold
       (`answer.p < CRITIQUE_FLAG_P - 0.01`). Ran it: red (nothing flagged). */
    const edited: ActWriteResult = {
      seams: [
        { seamId: "s0", script: `${S0_KEEP} The walkway stood for a year before anyone looked again.`, claims: [claim("approved without calculation")], usedClaims: [0], pronunciationHints: [] },
        { seamId: "s1", script: "A writer that ignored FROZEN.", claims: [], usedClaims: [], pronunciationHints: [] },
        { seamId: "s2", script: "", claims: [], usedClaims: [], pronunciationHints: [] }
      ]
    };
    const critic = new FakeDraftCritic([{ match: S0_BAD, p: CRITIQUE_FLAG_P - 0.01 }]);
    const { inner, writer, observed, ctx } = harness("all", [draft(), edited], critic);
    const out = await writer.writeAct(request(), ctx(1));

    expect(inner.requests).toHaveLength(2);
    const [s0, s1, s2] = inner.requests[1]!.seams;
    expect(s0).toMatchObject({ seamId: "s0", previousScript: `${S0_KEEP} ${S0_BAD}` });
    expect(s0!.frozen).toBeUndefined();
    expect(s0!.notes).toBe(`Not backed by the act's sources: «${S0_BAD}» - drop or re-source it; keep every other sentence.`);
    expect(s1).toMatchObject({ seamId: "s1", frozen: true, previousScript: `${S1_FIRST} ${S1_IMPERATIVE}` });
    expect(s2).toMatchObject({ seamId: "s2", frozen: true, previousScript: S2_ONLY });
    expect(s1!.notes).toBeUndefined();
    /* The edit is the round-1 request otherwise: no retry note invented. */
    expect(inner.requests[1]!.retryNote).toBeUndefined();
    expect(inner.requests[1]!.clips).toEqual(inner.requests[0]!.clips);

    expect(out.seams[0]).toEqual(edited.seams[0]);
    expect(out.seams[1]).toEqual(draft().seams[1]);
    expect(out.seams[2]).toEqual(draft().seams[2]);
    expect(observed[0]).toMatchObject({ flagged: 1, editedSeams: 1, editCalls: 1, editErrors: 0, critiqueCalls: 4 });
    expect(observed[0]!.pValues).toEqual([0.9, CRITIQUE_FLAG_P - 0.01, 0.9, 0.9]);
  });

  it("a flagged seam missing from the edit reply keeps its draft", async () => {
    /* MUTATION THAT KILLS THIS: map a missing edited seam to undefined
       (drop the `?? seam`). Ran it: red (s0 lost). */
    const critic = new FakeDraftCritic([{ match: S0_BAD, p: 0 }]);
    const { writer, ctx } = harness("all", [draft(), { seams: [] }], critic);
    const out = await writer.writeAct(request(), ctx(1));
    expect(out).toEqual(draft());
  });

  it("an edit call that throws returns the draft and the act continues", async () => {
    /* MUTATION THAT KILLS THIS: drop the try/catch around the edit call. Ran
       it: red (writeAct rejects). */
    const d = draft();
    const critic = new FakeDraftCritic([{ match: S0_BAD, p: 0.1 }]);
    const { inner, writer, observed, ctx } = harness("all", [d, { throw: "the lane is gone" }], critic);
    expect(await writer.writeAct(request(), ctx(1))).toBe(d);
    expect(inner.requests).toHaveLength(2);
    expect(observed[0]).toMatchObject({ flagged: 1, editCalls: 1, editErrors: 1 });
  });

  it("a structure leak or banned copy is flagged in code without asking the critic; a critic that throws leaves its sentence unflagged", async () => {
    /* MUTATION THAT KILLS THIS: drop `codeFlagOf` (the leak and the banned
       word go to the critic, which passes them), or count a throwing
       critic as a flag. Ran both: red. */
    const leak = "In this act we turn to the drawing itself.";
    const banned = "It is a fascinating drawing in its way.";
    const d: ActWriteResult = {
      seams: [
        { ...draft().seams[0]!, script: `${S0_KEEP} ${leak}` },
        { ...draft().seams[1]!, script: `${banned} ${S1_FIRST}` },
        draft().seams[2]!
      ]
    };
    const critic = new FakeDraftCritic([{ match: S2_ONLY, throw: "jev 503" }]);
    const { inner, writer, observed, ctx } = harness("all", [d, d], critic);
    await writer.writeAct(request(), ctx(1));
    expect(critic.questions.map((q) => q.sentence)).toEqual([S0_KEEP, S1_FIRST, S2_ONLY]);
    const edit = inner.requests[1]!;
    expect(edit.seams[0]!.notes).toMatch(/^Names the Foray's own structure: «In this act we turn/);
    expect(edit.seams[1]!.notes).toBe(`Uses banned copy: «${banned}» - rewrite it; keep every other sentence.`);
    expect(edit.seams[2]!.frozen).toBe(true);
    expect(observed[0]).toMatchObject({ sentences: 5, flagged: 2, editedSeams: 2, critiqueCalls: 3, critiqueErrors: 1, pValues: [0.9, 0.9] });
  });

  it("each critic question carries only its seam's own claim quotes and the windows of the clips it follows or introduces, within the ~2k-token budget", async () => {
    /* MUTATION THAT KILLS THIS: hand every question the act's documents
       (`request.documents`), or drop the budget slice. Ran both: red. */
    const longWindow = `${WINDOW_B} ${"And the replays kept showing the wheels slide. ".repeat(400)}`;
    expect(longWindow.length).toBeGreaterThan(CRITIQUE_SOURCE_BUDGET_CHARS);
    const { critic, writer, ctx } = harness("all", [draft()]);
    await writer.writeAct(request({}, longWindow), ctx(1));
    const bySentence = new Map(critic.questions.map((q) => [q.sentence, q.sources]));

    expect(bySentence.get(S0_KEEP)).toEqual([
      { docId: PRINT_ID, text: "were not checked for adequacy at any stage of the design" },
      { docId: WINDOW_A_ID, text: WINDOW_A }
    ]);
    const s1 = bySentence.get(S1_FIRST)!;
    expect(s1.map((s) => s.docId)).toEqual([PRINT_ID, WINDOW_A_ID, WINDOW_B_ID]);
    expect(s1[0]!.text).toBe("Investigators traced the change to a shop drawing");
    expect(s1.reduce((n, s) => n + s.text.length, 0)).toBe(CRITIQUE_SOURCE_BUDGET_CHARS);
    expect(longWindow.startsWith(s1[2]!.text)).toBe(true);
    const s2 = bySentence.get(S2_ONLY)!;
    expect(s2.map((s) => s.docId)).toEqual([PRINT_ID, WINDOW_B_ID]);
    /* Never another seam's quote. */
    expect(JSON.stringify(s2)).not.toContain("Investigators traced");
    expect(JSON.stringify(bySentence.get(S0_KEEP))).not.toContain(WINDOW_B.slice(0, 30));
  });

  it("seamCritiqueSources: duplicate sources once, empty texts skipped, nothing past the budget", () => {
    /* MUTATION THAT KILLS THIS: drop the `seen` set or the `left <= 0`
       stop. Ran both: red. */
    const req = request();
    const seam: WrittenSeam = { ...draft().seams[0]!, claims: [claim("were not checked"), claim("were not checked"), claim("   ")] };
    expect(seamCritiqueSources(req.seams[0]!, seam, req)).toEqual([
      { docId: PRINT_ID, text: "were not checked" },
      { docId: WINDOW_A_ID, text: WINDOW_A }
    ]);
    expect(seamCritiqueSources(req.seams[0]!, seam, req, 3)).toEqual([{ docId: PRINT_ID, text: "wer" }]);
  });

  it("GV-124: seamCritiqueSources keeps only quotes that are exact substrings of the document they name; an invented quote never backs its own sentence", async () => {
    /* MUTATION THAT KILLS THIS: drop the substring filter (#1413 item 9: the
       critique runs before the mechanical quote gate). Ran it: red (the
       made-up quote is handed to the critic as the sentence's source). */
    const INVENTED = "Everyone on the project knew the walkway would fall";
    const req = request();
    const seam: WrittenSeam = {
      ...draft().seams[0]!,
      claims: [
        claim(INVENTED),
        claim("were not checked for adequacy"),
        /* A real sentence of the print, named against the wrong document. */
        claim("approved without calculation", WINDOW_A_ID),
        /* Not exact: one word changed. */
        claim("were never checked for adequacy")
      ]
    };
    expect(seamCritiqueSources(req.seams[0]!, seam, req)).toEqual([
      { docId: PRINT_ID, text: "were not checked for adequacy" },
      { docId: WINDOW_A_ID, text: WINDOW_A }
    ]);
    /* Through the decorator: the critic is never shown the invented quote. */
    const d = draft();
    d.seams[0] = { ...d.seams[0]!, claims: [claim(INVENTED)] };
    const { critic, writer, ctx } = harness("all", [d]);
    await writer.writeAct(request(), ctx(1));
    const shown = critic.questions.find((q) => q.sentence === S0_BAD)!;
    expect(shown.sources).toEqual([{ docId: WINDOW_A_ID, text: WINDOW_A }]);
    expect(critic.questions.flatMap((q) => q.sources).some((src) => src.text.includes(INVENTED))).toBe(false);
  });

  it("forwards editSeams to the inner writer; offers writeActStream only when the inner writer streams", async () => {
    /* MUTATION THAT KILLS THIS: drop the editSeams forward, or offer
       writeActStream over a writer that cannot stream. Ran both: red. */
    const stub = new StubNarrationWriterBuilder();
    const writer = new SelfCritiquingNarrationWriter({ inner: stub, critic: new FakeDraftCritic(), mode: "all" });
    expect(typeof writer.writeActStream).toBe("function");
    expect(writer.providerName).toBe("stub");
    const req = request();
    const edit: SeamEditRequest = { actTitle: req.actTitle, voice, seams: [req.seams[2]!], neighbours: [], clips: req.clips, documents: req.documents, retryNote: "r" };
    expect(await writer.editSeams!(edit, { userId: "u" })).toEqual(await stub.editSeams(edit, { userId: "u" }));
    const plain: NarrationWriterBuilder = { providerName: "p", writeAct: async () => ({ seams: [] }) };
    const overPlain = new SelfCritiquingNarrationWriter({ inner: plain, critic: new FakeDraftCritic(), mode: "all" });
    expect(overPlain.editSeams).toBeUndefined();
    expect(overPlain.writeActStream).toBeUndefined();
  });

  it("GV-124: an act it does not critique is the inner writer's own stream; a critiqued act is written, critiqued and handed on whole", async () => {
    /* MUTATION THAT KILLS THIS: drop writeActStream from the decorator
       (#1413 item 7: self-critique switched streaming off, act 0 included);
       or stream every act through the inner stream (a critiqued act would
       skip the critique). Ran both: red. */
    class StreamingScripted extends ScriptedWriter {
      streams = 0;
      readonly marker = { type: "end" as const, stopReason: "end" as const, unfinishedSeamIds: [] as string[] };
      async *writeActStream(): AsyncGenerator<WriterStreamEvent> {
        this.streams++;
        for (const [i, seam] of draft().seams.entries()) yield { type: "seam", seam, atMs: 10 * (i + 1) };
        yield this.marker;
      }
    }
    const edited = draft();
    edited.seams[0] = { ...edited.seams[0]!, script: S0_KEEP };
    const inner = new StreamingScripted([draft(), edited]);
    const critic = new FakeDraftCritic([{ match: S0_BAD, p: 0.1 }]);
    const observed: WriterObservation[] = [];
    const writer = new SelfCritiquingNarrationWriter({ inner, critic, mode: "behind-playhead", now: () => 1000 });
    const ctx = (actIndex: number): NarrationBuildContext => ({ userId: "founder-1", actIndex, observe: (e) => observed.push(e) });
    const drain = async (stream: AsyncIterable<WriterStreamEvent>): Promise<WriterStreamEvent[]> => {
      const out: WriterStreamEvent[] = [];
      for await (const e of stream) out.push(e);
      return out;
    };

    /* Act 0 under behind-playhead: the inner stream, event for event. */
    const act0 = await drain(writer.writeActStream!(request(), ctx(0)));
    expect(inner.streams).toBe(1);
    expect(inner.requests).toHaveLength(0);
    expect(critic.calls).toBe(0);
    expect(act0.map((e) => (e.type === "seam" ? e.atMs : e))).toEqual([10, 20, 30, inner.marker]);
    expect(act0.at(-1)).toBe(inner.marker);

    /* A retry round passes through too. */
    await drain(writer.writeActStream!(request({ retryNote: "fix s2" }), ctx(1)));
    expect(inner.streams).toBe(2);
    expect(critic.calls).toBe(0);

    /* Act 1: written (draft + one edit call), critiqued, then every seam at once. */
    const act1 = await drain(writer.writeActStream!(request(), ctx(1)));
    expect(inner.streams).toBe(2);
    expect(inner.requests).toHaveLength(2);
    expect(critic.calls).toBeGreaterThan(0);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ acts: 1, editCalls: 1, flagged: 1 });
    const seams = act1.filter((e): e is Extract<WriterStreamEvent, { type: "seam" }> => e.type === "seam").map((e) => e.seam);
    expect(seams.map((x) => x.seamId)).toEqual(["s0", "s1", "s2"]);
    expect(seams[0]!.script).toBe(S0_KEEP);
    expect(act1.at(-1)).toEqual({ type: "end", stopReason: "end", unfinishedSeamIds: [] });
  });

  it("GV-124: wrapped around a streaming writer, GV-73 streaming survives for act 0 under behind-playhead", async () => {
    /* MUTATION THAT KILLS THIS: drop writeActStream from the decorator.
       Ran it: red (writeAct.ts takes the one-shot path: the inner stream is
       never opened and the stats carry no streaming counters). */
    let streams = 0;
    class CountingStream extends StubNarrationWriterBuilder {
      override async *writeActStream(request: ActWriteRequest, buildCtx: NarrationBuildContext): AsyncGenerator<WriterStreamEvent> {
        streams++;
        yield* super.writeActStream(request, buildCtx);
      }
    }
    const critic = new FakeDraftCritic();
    const writer = new SelfCritiquingNarrationWriter({ inner: new CountingStream(), critic, mode: "behind-playhead" });
    const stats: NarrationWriteStats = { retryRounds: 0 };
    const act = await writeActNarration(
      oneClipAct(),
      { writer, verifier: new StubNarrationVerifierBuilder(), evidence: actGatherer(), streamSeams: true, stats },
      voice,
      { userId: "founder-1", actIndex: 0 }
    );
    expect(streams).toBeGreaterThanOrEqual(1);
    expect(typeof stats.seamsReleasedEarly).toBe("number");
    expect(critic.calls).toBe(0);
    expect(allWrittenNarration([act]).length).toBeGreaterThan(0);
  });
});

/* ---------------------------------------- the real verifier still runs */

const ITEM_A = "practical-ai--skills-over-models";
const SEGMENT_A = `${ITEM_A}#410`;
const ANCHOR_A = "so the first thing to understand is";
const ACT_WINDOW =
  "Before the break we were talking about hiring, and how long it takes to find people who can maintain a pipeline. " +
  `${ANCHOR_A} that the mix of skills in the organization decides the tools, and the model choice comes last, ` +
  "because a team that cannot keep a pipeline running will not keep any model running for long.";
const NBS: EvidenceDoc = { docId: PRINT_ID, kind: "print", title: "National Bureau of Standards, Building Science Series 143 (1982)", text: PRINT };
const TAPE_A: TapePointer = { segmentId: SEGMENT_A, itemId: ITEM_A, startSec: 410, endSec: 530, startAnchor: ANCHOR_A, endAnchor: "running for long", tier: 1, confidence: "high" };
const CLAIM_B0 = "The connection was never checked for adequacy at any stage.";
const CLAIM_B2 = "Investigators traced the change to a fabricator's shop drawing.";

function oneClipAct(): SourcedAct {
  const narration = (c: string) => ({ sourcing: "narration" as const, claim: c, exploration: false, narration: { mode: "Patch" as const, reason: "t" } });
  return {
    title: "Act 2: The drawing",
    slots: [{ title: "Opening", beats: [narration(CLAIM_B0), { sourcing: "tape" as const, claim: "A guest explains why skills decide the tools.", exploration: false, tape: TAPE_A }, narration(CLAIM_B2)] }]
  };
}

function actGatherer(): EvidenceGatherer {
  const windowDoc: EvidenceDoc = { docId: tapeDocIdFor(SEGMENT_A), kind: "tape", title: "Practical AI — Skills over models", text: ACT_WINDOW };
  return {
    async gather(beat: EvidenceBeat): Promise<EvidencePack> {
      const docs: EvidenceDoc[] = [];
      if (beat.tape) docs.push({ ...windowDoc, tapePosition: "next" });
      else {
        if (beat.adjacentTape?.previous || beat.adjacentTape?.next) docs.push({ ...windowDoc, tapePosition: beat.adjacentTape?.next ? "next" : "previous" });
        docs.push(NBS);
      }
      return {
        purpose: beat.claim,
        beatKind: "account",
        docs,
        ...(beat.tape ? { tape: { itemId: ITEM_A, showTitle: "Practical AI", episodeTitle: "Skills over models", startSec: 410, endSec: 530 } } : {})
      };
    }
  };
}

describe("GV-94: wrapped in writeActNarration, the real verifier still runs after the critique", () => {
  it("the critique edits the flagged seam once, then the verifier judges the edited text and the act lands with it", async () => {
    /* MUTATION THAT KILLS THIS: return the draft after the edit call (drop
       the merge). Ran it: red (the verifier judges the draft, not the
       edit). */
    const stub = new StubNarrationWriterBuilder();
    const calls = { write: 0, verify: 0 };
    const writeRequests: ActWriteRequest[] = [];
    const realWrite = stub.writeAct.bind(stub);
    const EDITED = "The same drawing also moved the load onto a single rod, which the original design never asked of it.";
    /* The Stub writes the draft; its second reply (the edit) is scripted:
       the flagged sentence is replaced in the seams it was sent back, and
       every other seam is scribbled on, which the merge must ignore. */
    stub.writeAct = async (req, buildCtx) => {
      calls.write++;
      writeRequests.push(req);
      const reply = await realWrite(req, buildCtx);
      if (calls.write === 1) return reply;
      return {
        seams: reply.seams.map((s) => {
          const brief = req.seams.find((b) => b.seamId === s.seamId)!;
          if (brief.frozen) return { ...s, script: "SCRIBBLE." };
          const quoted = /«(.+?)»/.exec(brief.notes ?? "")![1]!;
          return { ...s, script: brief.previousScript!.replace(quoted, EDITED) };
        })
      };
    };
    const verifier = new StubNarrationVerifierBuilder();
    const verifyRequests: ActVerifyRequest[] = [];
    const realVerify = verifier.verifyAct.bind(verifier);
    verifier.verifyAct = async (req, buildCtx) => {
      calls.verify++;
      verifyRequests.push(req);
      return realVerify(req, buildCtx);
    };
    /* Flag the first sentence that carries b2's idea. */
    const critic = new FakeDraftCritic([{ match: /shop drawing/, p: 0.1 }]);
    const observed: WriterObservation[] = [];
    const writer = new SelfCritiquingNarrationWriter({ inner: stub, critic, mode: "behind-playhead" });

    const act = await writeActNarration(oneClipAct(), { writer, verifier, evidence: actGatherer() }, voice, {
      userId: "founder-1",
      actIndex: 1,
      observe: (e) => observed.push(e)
    });

    const flagged = critic.questions.find((q) => /shop drawing/.test(q.sentence));
    expect(flagged).toBeDefined();
    const flaggedSentence = flagged!.sentence;
    expect(calls.write).toBe(2);
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ acts: 1, editCalls: 1, editedSeams: 1, flagged: 1 });
    const editRequest = writeRequests[1]!;
    const sentBack = editRequest.seams.filter((s) => !s.frozen);
    expect(sentBack).toHaveLength(1);
    expect(sentBack[0]!.notes).toContain(`«${flaggedSentence}»`);

    /* The verifier ran (once: the stub passes the edited text), on the
       edited seam, never on a scribble. */
    expect(calls.verify).toBeGreaterThanOrEqual(1);
    const judged = JSON.stringify(verifyRequests[0]!.seams);
    expect(judged).toContain(EDITED);
    expect(judged).not.toContain(flaggedSentence);
    expect(judged).not.toContain("SCRIBBLE");
    const pages: NarratedBeat[] = allWrittenNarration([act]);
    expect(pages.some((p) => p.script.includes(EDITED))).toBe(true);
    expect(pages.every((p) => !p.script.includes("SCRIBBLE"))).toBe(true);
  });
});

/* -------------------------------------------- factory, flags, record */

describe("GV-94: createNarrationWriterBuilder and the flags", () => {
  it("FORAY_WRITER_SELF_CRITIQUE unset or off: the routed writer, not wrapped", () => {
    /* MUTATION THAT KILLS THIS: wrap even when off (drop the off return in
       createNarrationWriterBuilder). Ran it: red. */
    expect(createNarrationWriterBuilder({})).toBeInstanceOf(StubNarrationWriterBuilder);
    expect(createNarrationWriterBuilder({ FORAY_WRITER_SELF_CRITIQUE: "off", FORAY_WRITER_CRITIC: "Not A Name" })).toBeInstanceOf(StubNarrationWriterBuilder);
  });

  it("behind-playhead|all with a registered critic: the routed writer wrapped with that critic", async () => {
    /* MUTATION THAT KILLS THIS: wrap with a fixed mode 'all' (act 0 is
       critiqued). Ran it: red. */
    const critic = new FakeDraftCritic([], 0);
    restores.push(__swapDraftCriticForTests("fake-gv94", () => critic));
    const built = createNarrationWriterBuilder({ FORAY_WRITER_SELF_CRITIQUE: "behind-playhead", FORAY_WRITER_CRITIC: "fake-gv94" });
    expect(built).toBeInstanceOf(SelfCritiquingNarrationWriter);
    expect(built.providerName).toBe("stub");
    const req = request();
    await built.writeAct(req, { userId: "u", actIndex: 0 });
    expect(critic.calls).toBe(0);
    await built.writeAct(req, { userId: "u", actIndex: 1 });
    expect(critic.calls).toBeGreaterThan(0);
  });

  it("refuses an unnamed or unregistered critic and the reserved 'cut', naming the variable, never its value", () => {
    /* MUTATION THAT KILLS THIS: fall back to off when FORAY_WRITER_CRITIC is
       missing, or accept 'cut'. Ran both: red. */
    const thrown = (source: NodeJS.ProcessEnv): RoutingConfigError => {
      try {
        createNarrationWriterBuilder(source);
      } catch (e) {
        return e as RoutingConfigError;
      }
      throw new Error("expected a refusal");
    };
    const unset = thrown({ FORAY_WRITER_SELF_CRITIQUE: "all" });
    expect(unset).toBeInstanceOf(RoutingConfigError);
    expect(unset.variable).toBe("FORAY_WRITER_CRITIC");
    const unknown = thrown({ FORAY_WRITER_SELF_CRITIQUE: "all", FORAY_WRITER_CRITIC: "nobody-here" });
    expect(unknown.variable).toBe("FORAY_WRITER_CRITIC");
    expect(unknown.message).not.toContain("nobody-here");
    const cut = thrown({ FORAY_WRITER_SELF_CRITIQUE: "cut", FORAY_WRITER_CRITIC: "nobody-here" });
    expect(cut.variable).toBe("FORAY_WRITER_SELF_CRITIQUE");
    expect(cut.message).toMatch(/reserved/);
    expect(() => readSelfCritique({ FORAY_WRITER_SELF_CRITIQUE: "1" })).toThrow(FlagValueError);
    expect(() => readSelfCritique({ FORAY_WRITER_SELF_CRITIQUE: "all", FORAY_WRITER_CRITIC: "Bad Name" })).toThrow(/FORAY_WRITER_CRITIC/);
    expect(() => createDraftCritic("nobody-here", {})).toThrow(RoutingConfigError);
    expect(() => registerDraftCritic("Bad Name", () => new FakeDraftCritic())).toThrow(FlagValueError);
  });

  it("the lever record is fixed by the configuration; the checkpoint variant is unchanged when off and carries the mode and critic when on", () => {
    /* MUTATION THAT KILLS THIS: append a self-critique part when off (every
       classic fingerprint moves), or leave it out when on (a resume mixes
       critiqued and plain acts). Ran both: red. */
    expect(selfCritiqueLever(readSelfCritique({}))).toBeUndefined();
    expect(selfCritiqueLever(readSelfCritique({ FORAY_WRITER_SELF_CRITIQUE: "behind-playhead", FORAY_WRITER_CRITIC: "jev" }))).toEqual({
      mode: "behind-playhead",
      critic: "jev",
      flagP: CRITIQUE_FLAG_P,
      sourceBudgetTokens: 2000
    });
    expect(joinCheckpointVariant(undefined, { mode: "off" })).toBeUndefined();
    expect(joinCheckpointVariant("narration=sequential", { mode: "off" })).toBe("narration=sequential");
    expect(joinCheckpointVariant(undefined, { mode: "all", critic: "jev" })).toBe("self-critique=all:jev");
    expect(joinCheckpointVariant("narration=sequential", { mode: "behind-playhead", critic: "qwen" })).toBe("narration=sequential|self-critique=behind-playhead:qwen");
  });

  it("addSelfCritique sums every count and keeps the p values in order", () => {
    /* MUTATION THAT KILLS THIS: overwrite instead of add (keep the last
       act's numbers). Ran it: red. */
    const one: WriterObservation = { kind: "self-critique", acts: 1, sentences: 4, flagged: 1, editedSeams: 1, editCalls: 1, editErrors: 0, critiqueCalls: 3, critiqueErrors: 1, ms: 20, pValues: [0.2, 0.9] };
    const two: WriterObservation = { ...one, sentences: 2, flagged: 0, editedSeams: 0, editCalls: 0, critiqueErrors: 0, ms: 5, pValues: [0.7] };
    expect(addSelfCritique(addSelfCritique(undefined, one), two)).toEqual({
      acts: 2,
      sentences: 6,
      flagged: 1,
      editedSeams: 1,
      editCalls: 1,
      editErrors: 0,
      critiqueCalls: 6,
      critiqueErrors: 1,
      ms: 25,
      pValues: [0.2, 0.9, 0.7]
    });
  });

  it("the banned-copy rule is one rule: validateNarratedBeat still reports each hit", () => {
    /* MUTATION THAT KILLS THIS: return only the first hit from
       bannedCopyHits. Ran it: red. */
    const page: NarratedBeat = { mode: "Patch", script: "A fascinating deep dive.", sources: [], pronunciationHints: [], verified: true };
    const codes = validateNarratedBeat(page, { bannedPhrasePatterns: [/fascinat/i, /deep[\s-]dive/i, /delve/i] }).issues.filter((i) => i.code === "banned-copy");
    expect(codes.map((i) => i.message)).toEqual(["script matches banned copy pattern /fascinat/i", "script matches banned copy pattern /deep[\\s-]dive/i"]);
  });
});
