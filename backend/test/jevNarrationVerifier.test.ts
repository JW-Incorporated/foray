import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RoutingConfigError, __swapStageImplementationForTests, type StageImplementation } from "../src/config/stageRouting";
import type { BudgetGuard } from "../src/cost/budgetGuard";
import { __setChatProviderForTests } from "../src/generation/chat/providerRegistry";
import { createNarrationVerifierBuilder } from "../src/generation/createNarrationVerifierBuilder";
import type { EvidenceBeat, EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import { readGateConfig } from "../src/generation/gateConfig";
import {
  BEAT_OPTIONS_MAX_CHARS,
  JevNarrationVerifierBuilder,
  VERIFY_BEAT_PURPOSE,
  VERIFY_SENTENCE_PURPOSE,
  seamSentences
} from "../src/generation/JevNarrationVerifierBuilder";
import type { JevQuestion, JevResult, JevState } from "../src/generation/jevTypes";
import type { ActVerifyRequest, ActVerifyResult, NarrationBuildContext } from "../src/generation/NarrationVerifierBuilder";
import type { ActWriteRequest } from "../src/generation/NarrationWriterBuilder";
import { StubNarrationVerifierBuilder, actVerdictFor } from "../src/generation/StubNarrationVerifierBuilder";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { allWrittenNarration, writeNarration, type WrittenAct } from "../src/generation/writeNarration";
import { contentTerms } from "../src/generation/sentenceSupport";
import { tapeDocIdFor } from "../src/types/narration";
import type { Voice } from "../src/types/spine";
import type { SourcedAct, TapePointer } from "../src/types/tapeSourcing";
import { FakeJevClient, choiceAnswer, noulAnswer, type FakeJevAnswer } from "./helpers/fakeJevClient";

/**
 * GV-51 (docs/roadmap/generation-v2.md, from W5-09): the Jev act verifier.
 * Per open beat one choice over the act's statement sentences and clips;
 * per statement one GV-27 support ask, with GV-34's specifics check on the
 * same texts; the seam's verdict built from its sentence verdicts. Offline
 * only: FakeJevClient and hand-built requests; the end-to-end case runs the
 * stub writer through writeNarration with the wrapped-builder pattern of
 * actNarration.test.ts:82-108, copied here. Every test names the mutation
 * that kills it.
 */

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
const ctx: NarrationBuildContext = { userId: "founder-1", sessionId: "session-1" };

/** A guard that records every charge and never stops anything. */
function recordingGuard(): BudgetGuard & { events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    async checkAndRecord(event: Record<string, unknown>) {
      events.push(event);
    }
  } as unknown as BudgetGuard & { events: Array<Record<string, unknown>> };
}

/* ------------------------------------------------------------ fixture */

const SHOW = "Practical AI";
const NBS_TEXT =
  "The box beam-hanger rod connections were not checked for adequacy at any stage of the design. " +
  "The as-built connection could support about sixty percent of the load required by the Kansas City Building Code. " +
  "Investigators traced the change to a shop drawing produced by the fabricator in nineteen eighty-seven.";
const WINDOW_C0 =
  "So the first thing to understand is that the mix of skills in the organization decides the tools, and the model choice comes last. " +
  "We saw that at three companies in a row, and each time the fix was a hire, not a model.";

const S0 =
  `Next, from ${SHOW}, "Skills over models". Who decides the tools? ` +
  "The connection was never checked at any stage of the design. " +
  "Investigators traced the change to a drawing made by the fabricator.";
const S1 = "The as-built connection could support about sixty percent of the code load. Listen for the turn.";

/** Two seams: s0 introduces c0 (intro, question, two statements), s1
 * follows it (a statement and a listener imperative). */
function twoSeamRequest(overrides: Partial<ActVerifyRequest> = {}): ActVerifyRequest {
  const nbs: EvidenceDoc = { docId: "print:nbs-143", kind: "print", title: "NBS BSS 143", text: NBS_TEXT };
  const tape: EvidenceDoc = { docId: "tape:c0", kind: "tape", title: `${SHOW} — Skills over models`, text: WINDOW_C0 };
  return {
    actTitle: "Act 1",
    voice,
    beats: [
      { beatId: "b0", claim: "The connection was never checked for adequacy at any stage.", mode: "Patch", kind: "account" },
      { beatId: "b1", claim: "Skills in the organization decide the tools, the model comes last.", mode: "Patch", kind: "account" }
    ],
    seams: [
      { seamId: "s0", script: S0, selected: ["k0"], carries: ["b0"], introduces: "c0", intro: "full" },
      { seamId: "s1", script: S1, selected: ["k1"], carries: ["b1"], follows: "c0" }
    ],
    clips: [
      {
        clipId: "c0",
        segmentId: "seg-a#410",
        itemId: "seg-a",
        show: SHOW,
        title: "Skills over models",
        docId: "tape:c0",
        opening: "",
        durationSec: 90,
        intro: "full",
        windowText: WINDOW_C0
      } as ActVerifyRequest["clips"][number]
    ],
    sources: [
      { id: "k0", kind: "claim", claimText: "The connections were not checked.", quote: "The box beam-hanger rod connections were not checked for adequacy at any stage of the design.", publication: "NBS", contested: false, selectedBy: "s0", docId: "print:nbs-143" },
      { id: "k1", kind: "claim", claimText: "The connection could support sixty percent.", quote: "The as-built connection could support about sixty percent of the load required by the Kansas City Building Code.", publication: "NBS", contested: false, selectedBy: "s1", docId: "print:nbs-143" },
      { id: "c0", kind: "clip", claimText: "what is said in clip c0", publication: "Practical AI", contested: false, docId: "tape:c0" }
    ],
    documents: [nbs, tape],
    ...overrides
  };
}

/** The key (s1..sN) of the candidate whose text contains `marker`. */
function keyHolding(state: JevState, marker: string): string {
  const sources = (state as { sources: Record<string, string> }).sources;
  return Object.keys(sources).find((k) => sources[k]!.includes(marker)) ?? "none";
}

interface SentenceScript {
  p: number;
  /** A phrase of the source the judge says the sentence rests on. */
  restsOn?: string;
}

/**
 * A fake Jev scripted per sentence (by a substring of it) and per beat (by
 * a substring of its claim -> the option id it picks, with p). An unscripted
 * sentence gets `fallback`; `failSentence` makes the ask for a sentence
 * containing it fail.
 */
function scriptedJev(opts: {
  sentences?: Record<string, SentenceScript>;
  fallback?: SentenceScript;
  beats?: Record<string, { choice: string; p: number }>;
  failSentence?: string;
  judge?: "jev" | "qwen";
}) {
  const sentenceScript = (state: JevState): SentenceScript => {
    const sentence = (state as { sentence: string }).sentence;
    for (const [marker, script] of Object.entries(opts.sentences ?? {})) if (sentence.includes(marker)) return script;
    return opts.fallback ?? { p: 0.9 };
  };
  const fake = new FakeJevClient({
    byId: {
      supported: (state) => noulAnswer(sentenceScript(state).p),
      restsOn: (state, question): FakeJevAnswer => {
        const script = sentenceScript(state);
        const key = script.restsOn ? keyHolding(state, script.restsOn) : "none";
        const probabilities: Record<string, number> = {};
        for (const k of Object.keys((question as { criteria: Record<string, unknown> }).criteria)) probabilities[k] = k === key ? 0.9 : 0.1 / 10;
        return choiceAnswer(key, probabilities);
      },
      carriedBy: (state, question): FakeJevAnswer => {
        const claim = (state as { claim: string }).claim;
        const keys = Object.keys((question as { criteria: Record<string, unknown> }).criteria);
        const scripted = Object.entries(opts.beats ?? {}).find(([marker]) => claim.includes(marker))?.[1];
        const choice = scripted && keys.includes(scripted.choice) ? scripted.choice : "none";
        const p = scripted && keys.includes(scripted.choice) ? scripted.p : 0.95;
        const probabilities: Record<string, number> = {};
        for (const k of keys) probabilities[k] = k === choice ? p : (1 - p) / Math.max(1, keys.length - 1);
        return choiceAnswer(choice, probabilities);
      }
    },
    fail: (state) => {
      const sentence = (state as { sentence?: string }).sentence;
      if (opts.failSentence && typeof sentence === "string" && sentence.includes(opts.failSentence)) return { category: "network", reason: "network_error" };
      return undefined;
    }
  });
  if (opts.judge === undefined) return fake;
  /* GV-47's tag, as FallbackJudgeClient / QwenJudgeClient set it. */
  const tagged = {
    calls: fake.calls,
    callsFor: fake.callsFor.bind(fake),
    async ask(state: JevState, questions: readonly JevQuestion[], o: { purpose: string }): Promise<JevResult> {
      const r = await fake.ask(state, questions, o);
      return { ...r, judge: opts.judge };
    }
  };
  return tagged as unknown as FakeJevClient;
}

function builder(client: FakeJevClient, guard = recordingGuard(), gates = readGateConfig({})) {
  return new JevNarrationVerifierBuilder({ client, budgetGuard: guard, gates });
}

/* ------------------------------------------------------------ unit cases */

describe("GV-51: sentences are classified and judged one by one", () => {
  it("a two-seam act maps exactly: the unsupported sentence is quoted, restsOn is the union, intro and question are exempt", async () => {
    /* MUTATION THAT KILLS THIS: drop the 'intro' branch of seamSentences
       (the intro sentence becomes a statement, is asked, and the call count
       and kinds change). Ran: red. Also: make claimsSupported ignore an
       'unsupported' sentence (s0 comes back true). Ran: red. */
    const jev = scriptedJev({
      sentences: {
        "never checked": { p: 0.9, restsOn: "beam-hanger" },
        "drawing made by": { p: 0.2 },
        "sixty percent": { p: 0.8, restsOn: "Kansas City" }
      },
      beats: { "never checked": { choice: "s0.2", p: 0.9 }, "Skills in the organization": { choice: "c0", p: 0.85 } }
    });
    const result = await builder(jev).verifyAct(twoSeamRequest(), ctx);

    const s0 = result.seams.find((s) => s.seamId === "s0")!;
    expect(s0.sentences!.map((s) => [s.index, s.kind, s.verdict])).toEqual([
      [0, "intro", "exempt"],
      [1, "question", "exempt"],
      [2, "statement", "supported"],
      [3, "statement", "unsupported"]
    ]);
    expect(s0.claimsSupported).toBe(false);
    expect(s0.notes).toContain('"Investigators traced the change to a drawing made by the fabricator."');
    expect(s0.restsOn).toEqual(["k0"]);
    expect(s0.contestedHandled).toBe(true);

    const s1 = result.seams.find((s) => s.seamId === "s1")!;
    expect(s1.sentences!.map((s) => [s.kind, s.verdict])).toEqual([
      ["statement", "supported"],
      ["imperative", "exempt"]
    ]);
    expect(s1.claimsSupported).toBe(true);
    expect(s1.restsOn).toEqual(["k1"]);
    expect(s1.notes).toBeUndefined();

    /* Only statements are asked: three sentences, two beats. */
    expect(jev.callsFor(VERIFY_SENTENCE_PURPOSE)).toHaveLength(3);
    expect(jev.callsFor(VERIFY_BEAT_PURPOSE)).toHaveLength(2);

    const b0 = result.beats.find((b) => b.beatId === "b0")!;
    expect(b0).toEqual({ beatId: "b0", carried: true, carriedBy: "s0", carriedBySentence: { seamId: "s0", index: 2 }, restsOn: ["k0"] });
  });

  it("restsOn is the union of the ids chosen across a seam's statements", async () => {
    /* MUTATION THAT KILLS THIS: keep only the first statement's restsOn in
       seamVerdictFromSentences. Ran: red (["k0"] alone). */
    const jev = scriptedJev({
      sentences: { "never checked": { p: 0.9, restsOn: "beam-hanger" }, "drawing made by": { p: 0.9, restsOn: "Kansas City" } }
    });
    const request = twoSeamRequest();
    request.seams[0]!.selected = ["k0", "k1"];
    const result = await builder(jev).verifyAct(request, ctx);
    const s0 = result.seams.find((s) => s.seamId === "s0")!;
    expect(s0.claimsSupported).toBe(true);
    expect(s0.restsOn).toEqual(["k0", "k1"]);
  });

  it("a beat carried only by a clip comes back carriedBy 'c0', resting on the clip", async () => {
    /* MUTATION THAT KILLS THIS: leave clips out of beatOptionsFor. Ran: red
       (the fake can only answer 'none', so b1 is not carried). */
    const jev = scriptedJev({ beats: { "Skills in the organization": { choice: "c0", p: 0.85 } } });
    const result = await builder(jev).verifyAct(twoSeamRequest(), ctx);
    const b1 = result.beats.find((b) => b.beatId === "b1")!;
    expect(b1).toEqual({ beatId: "b1", carried: true, carriedBy: "c0", restsOn: ["c0"] });
    /* The clip option is its window's passage around the claim. */
    const ask = jev.callsFor(VERIFY_BEAT_PURPOSE).find((c) => (c.state as { claim: string }).claim.includes("Skills"))!;
    expect((ask.state as { options: Record<string, string> }).options.c0).toBe(WINDOW_C0);
    expect(Object.keys(ask.questions[0]!.criteria)).toEqual(["s0.2", "s0.3", "s1.0", "c0", "none"]);
  });

  it("'in 1991' against sources saying 'nineteen eighty-seven' is unsupported even when Jev gives p=0.9", async () => {
    /* MUTATION THAT KILLS THIS: skip the unsupportedSpecifics result in
       sentenceVerdictsFor (the judge's 0.9 then passes it). Ran: red. */
    const jev = scriptedJev({ fallback: { p: 0.9, restsOn: "beam-hanger" } });
    const request = twoSeamRequest();
    request.seams[0]!.script = `Next, from ${SHOW}, "Skills over models". Investigators traced the change to a shop drawing produced by the fabricator in 1991.`;
    const result = await builder(jev).verifyAct(request, ctx);
    const s0 = result.seams.find((s) => s.seamId === "s0")!;
    const statement = s0.sentences!.find((s) => s.kind === "statement")!;
    expect(statement.verdict).toBe("unsupported");
    expect(statement.p).toBe(0.9);
    expect(statement.specifics).toEqual(["1991"]);
    expect(s0.claimsSupported).toBe(false);
    expect(s0.notes).toContain("It states 1991");

    /* The same sentence with the year the source carries passes. */
    request.seams[0]!.script = `Next, from ${SHOW}, "Skills over models". Investigators traced the change to a shop drawing produced by the fabricator in 1987.`;
    const fixed = await builder(scriptedJev({ fallback: { p: 0.9, restsOn: "beam-hanger" } })).verifyAct(request, ctx);
    expect(fixed.seams.find((s) => s.seamId === "s0")!.claimsSupported).toBe(true);
  });

  it("Jev unavailable for one sentence gives 'unknown' and the seam is not confirmed", async () => {
    /* MUTATION THAT KILLS THIS: map an unavailable verdict to 'supported'
       (or let claimsSupported accept 'unknown'). Ran: red. */
    const jev = scriptedJev({ fallback: { p: 0.9, restsOn: "beam-hanger" }, failSentence: "sixty percent" });
    const result = await builder(jev).verifyAct(twoSeamRequest(), ctx);
    const s1 = result.seams.find((s) => s.seamId === "s1")!;
    expect(s1.sentences![0]).toEqual({ index: 0, text: "The as-built connection could support about sixty percent of the code load.", kind: "statement", verdict: "unknown" });
    expect(s1.claimsSupported).toBe(false);
    expect(s1.notes).toContain('Unconfirmed: "The as-built connection');
    expect(result.seams.find((s) => s.seamId === "s0")!.claimsSupported).toBe(true);
  });

  it("a frozen seam is not judged, but its sentences can still carry a beat", async () => {
    /* MUTATION THAT KILLS THIS: drop frozen seams from beatOptionsFor (b0's
       carrier vanishes). Ran: red. Or judge frozen seams again (a seam
       verdict for s0 appears). Ran: red. */
    const jev = scriptedJev({ beats: { "never checked": { choice: "s0.2", p: 0.9 } } });
    const request = twoSeamRequest();
    request.seams[0]!.frozen = true;
    const result = await builder(jev).verifyAct(request, ctx);
    expect(result.seams.map((s) => s.seamId)).toEqual(["s1"]);
    expect(jev.callsFor(VERIFY_SENTENCE_PURPOSE).map((c) => (c.state as { sentence: string }).sentence)).toEqual([
      "The as-built connection could support about sixty percent of the code load."
    ]);
    expect(result.beats.find((b) => b.beatId === "b0")).toMatchObject({ carried: true, carriedBy: "s0", carriedBySentence: { seamId: "s0", index: 2 } });
  });
});

describe("GV-51: the beat threshold is the answering judge's", () => {
  it("p below FORAY_SUPPORT_MIN_P_JEV is not carried; the note names the claim and the seam it was positioned in", async () => {
    /* MUTATION THAT KILLS THIS: carry a beat on any non-'none' top option,
       whatever its p. Ran: red. */
    const jev = scriptedJev({ beats: { "never checked": { choice: "s0.2", p: 0.4 } } });
    const result = await builder(jev).verifyAct(twoSeamRequest(), ctx);
    const b0 = result.beats.find((b) => b.beatId === "b0")!;
    expect(b0.carried).toBe(false);
    expect(b0.notes).toMatch(/no sentence of the act's prose and no clip carries the claim "The connection was never checked/);
    expect(b0.notes).toContain("positioned in seam s0");
  });

  it("a Qwen-judge answer is read against the Qwen threshold (0.7), not Jev's (0.5)", async () => {
    /* MUTATION THAT KILLS THIS: read supportMinP.jev whatever result.judge
       says. Ran: red (0.6 passes the Jev threshold). */
    const beats = { "never checked": { choice: "s0.2", p: 0.6 } };
    const viaJev = await builder(scriptedJev({ beats, judge: "jev" })).verifyAct(twoSeamRequest(), ctx);
    expect(viaJev.beats.find((b) => b.beatId === "b0")!.carried).toBe(true);
    const viaQwen = await builder(scriptedJev({ beats, judge: "qwen" })).verifyAct(twoSeamRequest(), ctx);
    expect(viaQwen.beats.find((b) => b.beatId === "b0")!.carried).toBe(false);
    /* The sentence path too: p = 0.6 supports under Jev, not under Qwen. */
    const fallback = { p: 0.6, restsOn: "beam-hanger" };
    const sJev = await builder(scriptedJev({ fallback, judge: "jev" })).verifyAct(twoSeamRequest(), ctx);
    const sQwen = await builder(scriptedJev({ fallback, judge: "qwen" })).verifyAct(twoSeamRequest(), ctx);
    expect(sJev.seams.find((s) => s.seamId === "s1")!.claimsSupported).toBe(true);
    expect(sQwen.seams.find((s) => s.seamId === "s1")!.claimsSupported).toBe(false);
  });

  it("options over 40,000 characters are split into two asks and the better carrier is kept", async () => {
    /* MUTATION THAT KILLS THIS: keep the FIRST ask's answer rather than the
       best non-'none' one across asks. Ran: red. */
    const long = (word: string) => `${word} ${"the record shows the walkway hung from rods ".repeat(Math.ceil(BEAT_OPTIONS_MAX_CHARS / 3 / 44))}`.trim() + ".";
    const request = twoSeamRequest({ clips: [] , sources: twoSeamRequest().sources.filter((s) => s.kind !== "clip") });
    request.seams = [
      { seamId: "s0", script: long("First"), selected: [], carries: ["b0"] },
      { seamId: "s1", script: long("Second"), selected: [], carries: [] },
      { seamId: "s2", script: long("Third"), selected: [], carries: [] }
    ];
    request.beats = [request.beats[0]!];
    const fake = new FakeJevClient({
      byId: {
        supported: noulAnswer(0.9),
        restsOn: (_s, q) => choiceAnswer("none", Object.fromEntries(Object.keys((q as { criteria: object }).criteria).map((k) => [k, k === "none" ? 1 : 0]))),
        carriedBy: (state, q) => {
          const keys = Object.keys((q as { criteria: object }).criteria);
          /* First ask: s0.0 at 0.55; second ask: s2.0 at 0.8. */
          const choice = keys.includes("s2.0") ? "s2.0" : "s0.0";
          const p = choice === "s2.0" ? 0.8 : 0.55;
          return choiceAnswer(choice, Object.fromEntries(keys.map((k) => [k, k === choice ? p : 0])));
        }
      }
    });
    const result = await builder(fake).verifyAct(request, ctx);
    const asks = fake.callsFor(VERIFY_BEAT_PURPOSE);
    expect(asks).toHaveLength(2);
    expect(asks.every((a) => Object.keys(a.questions[0]!.criteria).includes("none"))).toBe(true);
    expect(result.beats[0]).toMatchObject({ carried: true, carriedBy: "s2", carriedBySentence: { seamId: "s2", index: 0 } });
  });
});

describe("GV-51: contested handling, metering and the stub's sentence mode", () => {
  it("contestedHandled is the stub's code rule, and Jev is never asked about it", async () => {
    /* MUTATION THAT KILLS THIS: return contestedHandled: true unconditionally.
       Ran: red. */
    const request = twoSeamRequest();
    request.sources = request.sources.map((s) => (s.id === "k1" ? { ...s, contested: true } : s));
    const jev = scriptedJev({ fallback: { p: 0.9, restsOn: "Kansas City" } });
    const result = await builder(jev).verifyAct(request, ctx);
    const s1 = result.seams.find((s) => s.seamId === "s1")!;
    expect(s1.restsOn).toEqual(["k1"]);
    expect(s1.contestedHandled).toBe(false);
    expect(s1.notes).toContain("marked contested");
    expect(new Set(jev.calls.map((c) => c.purpose))).toEqual(new Set([VERIFY_BEAT_PURPOSE, VERIFY_SENTENCE_PURPOSE]));

    request.seams[1]!.script = "The as-built connection could support about sixty percent of the code load, though this is disputed.";
    const hedged = await builder(scriptedJev({ fallback: { p: 0.9, restsOn: "Kansas City" } })).verifyAct(request, ctx);
    expect(hedged.seams.find((s) => s.seamId === "s1")!.contestedHandled).toBe(true);
  });

  it("every ask is charged to the BudgetGuard under the run's user and session, labelled by purpose", async () => {
    /* MUTATION THAT KILLS THIS: hand the raw client to the pool instead of
       meteredJevClient. Ran: red (no events). */
    const guard = recordingGuard();
    const jev = scriptedJev({});
    await builder(jev, guard).verifyAct(twoSeamRequest(), ctx);
    expect(guard.events).toHaveLength(jev.calls.length);
    expect(guard.events.every((e) => e.provider === "jev" && e.userId === "founder-1" && e.sessionId === "session-1")).toBe(true);
    expect(guard.events.map((e) => e.operation).sort()).toEqual(jev.calls.map((c) => c.purpose).sort());
  });

  it("the stub's sentence mode is opt-in: off, its verdict is exactly actVerdictFor; on, it adds sentence verdicts and changes nothing else", async () => {
    /* MUTATION THAT KILLS THIS: default emitSentences to true (the default
       verdict gains `sentences`). Ran: red. */
    const request = twoSeamRequest();
    const guard = recordingGuard();
    const off = await new StubNarrationVerifierBuilder(guard).verifyAct(request, ctx);
    expect(off).toEqual(actVerdictFor(request));
    const on = await new StubNarrationVerifierBuilder(guard, { emitSentences: true }).verifyAct(request, ctx);
    expect(on.beats).toEqual(off.beats);
    expect(on.seams.map((seam) => Object.fromEntries(Object.entries(seam).filter(([k]) => k !== "sentences")))).toEqual(off.seams);
    const s0 = on.seams.find((s) => s.seamId === "s0")!.sentences!;
    expect(s0.map((s) => s.kind)).toEqual(["intro", "question", "statement", "statement"]);
    expect(s0[2]).toMatchObject({ verdict: "supported", restsOn: ["k0"] });
  });

  it("seamSentences counts a listener imperative and a short fragment as exempt imperatives", () => {
    /* MUTATION THAT KILLS THIS: classify every non-question as a statement.
       Ran: red. */
    const kinds = seamSentences({ seamId: "s9", script: "Listen for the hum. Then silence. The hum was the dam failing.", selected: [], carries: [] }, []).map((s) => s.kind);
    expect(kinds).toEqual(["imperative", "imperative", "statement"]);
  });
});

/* ------------------------------------------------------------ routing */

describe("GV-51: FORAY_STAGE_VERIFIER=jev through the routing table", () => {
  beforeEach(() => __setChatProviderForTests(undefined));
  afterEach(() => __setChatProviderForTests(undefined));

  it("selects the Jev builder with a key, throws RoutingConfigError naming JEV_API_KEY without one, and leaves the default route alone", () => {
    /* MUTATION THAT KILLS THIS: drop the key check in
       createNarrationVerifierBuilder (a keyless jev route builds a verifier
       that can never confirm anything). Ran: red. Or register nothing under
       'jev' (no implementation is registered). Ran: red. */
    expect(createNarrationVerifierBuilder({})).toBeInstanceOf(StubNarrationVerifierBuilder);
    expect(createNarrationVerifierBuilder({ FORAY_STAGE_VERIFIER: "jev", JEV_API_KEY: "k-test" })).toBeInstanceOf(JevNarrationVerifierBuilder);
    let err: unknown;
    try {
      createNarrationVerifierBuilder({ FORAY_STAGE_VERIFIER: "jev" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RoutingConfigError);
    expect((err as RoutingConfigError).variable).toBe("JEV_API_KEY");
    expect((err as Error).message).not.toContain("k-test");
  });

  it("a swapped 'jev' registration is what the route builds", () => {
    /* MUTATION THAT KILLS THIS: construct JevNarrationVerifierBuilder in the
       factory directly, bypassing the registry. Ran: red. */
    const sentinel = { providerName: "sentinel", verifyAct: async () => ({ beats: [], seams: [] }) };
    const restore = __swapStageImplementationForTests("verifier", "jev", {
      create: () => sentinel,
      describe: (c) => ({ model: c.route.model })
    } as StageImplementation<typeof sentinel>);
    try {
      expect(createNarrationVerifierBuilder({ FORAY_STAGE_VERIFIER: "jev", JEV_API_KEY: "k-test" })).toBe(sentinel);
    } finally {
      restore();
    }
  });
});

/* ------------------------------------------------------------ end to end */

/* The act fixture of actNarration.test.ts (four narration beats, two
   clips), copied: s0 {b0, b1} -> c0; s1 {b3} -> c1; s2 {b5}. */
const ITEM_A = "practical-ai--skills-over-models";
const ITEM_B = "practical-ai--a-robot-in-a-simulator";
const SEGMENT_A = `${ITEM_A}#410`;
const SEGMENT_B = `${ITEM_B}#980`;
const TITLE_A = "Skills over models";
const TITLE_B = "A robot in a simulator";
const ANCHOR_A = "so the first thing to understand is";
const ANCHOR_B = "when we put the robot in the simulator";
const WINDOW_A =
  "Before the break we were talking about hiring, and how long it takes to find people who can maintain a pipeline. " +
  `${ANCHOR_A} that the mix of skills in the organization decides the tools, and the model choice comes last, ` +
  "because a team that cannot keep a pipeline running will not keep any model running for long. " +
  "We saw that at three companies in a row, and each time the fix was a hire, not a model.";
const WINDOW_B =
  "That was the part of the conversation about tooling, which we will come back to. " +
  `${ANCHOR_B} the first thing that broke was the physics, not the policy, ` +
  "and it took a week of watching replays to see that the wheels were sliding on a floor that did not exist. " +
  "Once the floor was fixed the policy started to learn again.";
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

function pointer(itemId: string, segmentId: string, startAnchor: string, startSec: number): TapePointer {
  return { segmentId, itemId, startSec, endSec: startSec + 120, startAnchor, endAnchor: "and each time the fix was a hire", tier: 1, confidence: "high" };
}
const TAPE_A = pointer(ITEM_A, SEGMENT_A, ANCHOR_A, 410);
const TAPE_B = pointer(ITEM_B, SEGMENT_B, ANCHOR_B, 980);
function narration(claim: string) {
  return { sourcing: "narration" as const, claim, exploration: false, narration: { mode: "Patch" as const, reason: "t" } };
}
function tapeBeat(claim: string, tapePointer: TapePointer) {
  return { sourcing: "tape" as const, claim, exploration: false, tape: tapePointer };
}
function fourBeatsTwoClips(): SourcedAct {
  return {
    title: "Act 1: Skills decide the tools",
    slots: [
      { title: "Opening", beats: [narration(CLAIMS.b0), narration(CLAIMS.b1), tapeBeat("A guest explains why skills decide the tools.", TAPE_A)] },
      { title: "The turn", beats: [narration(CLAIMS.b2), tapeBeat("The robot in the simulator.", TAPE_B), narration(CLAIMS.b3)] }
    ]
  };
}
function gatherer(): EvidenceGatherer {
  const windows: Record<string, string> = { [SEGMENT_A]: WINDOW_A, [SEGMENT_B]: WINDOW_B };
  const titles: Record<string, { show: string; title: string }> = { [ITEM_A]: { show: SHOW, title: TITLE_A }, [ITEM_B]: { show: SHOW, title: TITLE_B } };
  const windowDoc = (p: TapePointer): EvidenceDoc | undefined => {
    const text = windows[p.segmentId];
    if (text === undefined) return undefined;
    const t = titles[p.itemId]!;
    return { docId: tapeDocIdFor(p.segmentId), kind: "tape", title: `${t.show} — ${t.title}`, text };
  };
  return {
    async gather(beat: EvidenceBeat): Promise<EvidencePack> {
      const docs: EvidenceDoc[] = [];
      let tapeContext: EvidencePack["tape"];
      if (beat.tape) {
        const own = windowDoc(beat.tape);
        if (own) docs.push({ ...own, tapePosition: "next" });
        const t = titles[beat.tape.itemId]!;
        tapeContext = { itemId: beat.tape.itemId, showTitle: t.show, episodeTitle: t.title, startSec: beat.tape.startSec, endSec: beat.tape.endSec };
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

/** A fake Jev that reads the way the real one should on this fixture: a
 * beat is carried by the option sharing the most content words with its
 * claim; a statement is supported (p 0.9) and rests on its first candidate,
 * except where `refuse(sentence, verifyCall)` says otherwise. */
function overlapJev(refuse: (sentence: string) => boolean): FakeJevClient {
  return new FakeJevClient({
    byId: {
      supported: (state) => noulAnswer(refuse((state as { sentence: string }).sentence) ? 0.1 : 0.9),
      restsOn: (_state, q) => {
        const keys = Object.keys((q as { criteria: object }).criteria);
        const choice = keys.includes("s1") ? "s1" : "none";
        return choiceAnswer(choice, Object.fromEntries(keys.map((k) => [k, k === choice ? 0.9 : 0])));
      },
      carriedBy: (state, q) => {
        const { claim, options } = state as { claim: string; options: Record<string, string> };
        const wanted = contentTerms(claim);
        let choice = "none";
        let best = 0;
        for (const [id, text] of Object.entries(options)) {
          const overlap = [...contentTerms(text)].filter((t) => wanted.has(t)).length;
          if (overlap > best) {
            best = overlap;
            choice = id;
          }
        }
        const keys = Object.keys((q as { criteria: object }).criteria);
        return choiceAnswer(choice, Object.fromEntries(keys.map((k) => [k, k === choice ? 0.9 : 0])));
      }
    }
  });
}

/** The wrapped-builder pattern of actNarration.test.ts:82-108: the stub
 * writer and the Jev verifier, counted, every request kept. */
function jevBuilders(jev: FakeJevClient) {
  const writer = new StubNarrationWriterBuilder(recordingGuard());
  const verifier = builder(jev);
  const calls = { write: 0, verify: 0 };
  const requests: ActWriteRequest[] = [];
  const verifyRequests: ActVerifyRequest[] = [];
  const verdicts: ActVerifyResult[] = [];
  const realWrite = writer.writeAct.bind(writer);
  writer.writeAct = async (request, buildCtx) => {
    calls.write++;
    requests.push(request);
    return realWrite(request, buildCtx);
  };
  const realVerify = verifier.verifyAct.bind(verifier);
  verifier.verifyAct = async (request, buildCtx) => {
    calls.verify++;
    verifyRequests.push(request);
    const verdict = await realVerify(request, buildCtx);
    verdicts.push(verdict);
    return verdict;
  };
  return { writer, verifier, calls, requests, verifyRequests, verdicts };
}

const narrationBeatsOf = (act: WrittenAct) => act.slots.flatMap((s) => s.beats).filter((b) => b.sourcing === "narration");

describe("GV-51 end to end: the stub writer and the Jev verifier through writeNarration", () => {
  it("finishes with frozen seams and verifiedAtAttempt set; a refused sentence re-opens only its own seam", async () => {
    /* MUTATION THAT KILLS THIS: drop `sentences`-derived claimsSupported (any
       seam with a refused statement passes on round 1, and the second
       round never happens). Ran: red. Or carry beats from 'none'. Ran: red. */
    let round = 0;
    const jev = overlapJev((sentence) => round === 1 && sentence.includes("traced the change"));
    const b = jevBuilders(jev);
    const realVerify = b.verifier.verifyAct;
    b.verifier.verifyAct = async (request, buildCtx) => {
      round += 1;
      return realVerify(request, buildCtx);
    };
    const [act] = await writeNarration([fourBeatsTwoClips()], { writer: b.writer, verifier: b.verifier, evidence: gatherer() }, voice, ctx);

    expect(b.calls).toEqual({ write: 2, verify: 2 });
    /* Round 1 refused s1 (its "traced the change" statement), quoting it. */
    const s1First = b.verdicts[0]!.seams.find((s) => s.seamId === "s1")!;
    expect(s1First.claimsSupported).toBe(false);
    expect(s1First.notes).toMatch(/Unsupported: ".*traced the change.*"/);
    /* Round 2: s0 and s2 are frozen (context, not judged); s1 alone is judged. */
    const second = b.verifyRequests[1]!;
    expect(second.seams.filter((s) => s.frozen).map((s) => s.seamId)).toEqual(["s0", "s2"]);
    expect(b.verdicts[1]!.seams.map((s) => s.seamId)).toEqual(["s1"]);
    expect(b.verdicts[1]!.seams[0]!.claimsSupported).toBe(true);

    const beats = narrationBeatsOf(act!) as Array<{ verifiedAtAttempt?: number }>;
    expect(beats).toHaveLength(4);
    /* b3 sits in s1: its round-1 carrier was edited, so it was re-checked
       and confirmed on round 2; the rest stood from round 1. */
    expect(beats.map((x) => x.verifiedAtAttempt)).toEqual([1, 1, 2, 1]);
    expect(allWrittenNarration([act!]).every((p) => p.verified)).toBe(true);
  });
});
