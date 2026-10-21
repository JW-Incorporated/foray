import { describe, it, expect } from "vitest";
import { HANDOFF_SCRIPT, pageOfWrittenBeat, type WrittenAct, type WrittenBeat } from "../src/generation/writeNarration";
import { INTRO_CUT_NOTE, writeActNarration, type WriteActOptions } from "../src/generation/writeAct";
import { introNamesShow } from "../src/generation/actSeams";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { GATE_TABLE, readGateConfig, resolveGateConfig } from "../src/generation/gateConfig";
import { INTERNAL_ONLY_FIELD_NAMES, assertNoInternalFieldsLeaked } from "../src/generation/forayItems";
import { buildVeracityMetrics, computePagesCut, computePagesDropped, computeSynthesisVerifiedPages, computeUnverifiedPages } from "../src/generation/veracityMetrics";
import {
  NarratedBeatSchema,
  droppedReasonOf,
  isIntroOnlyVerified,
  isSynthesisVerified,
  tapeDocIdFor,
  type NarratedBeat
} from "../src/types/narration";
import type { EvidenceBeat, EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type { ActWriteRequest, ActWriteResult, NarrationBuildContext } from "../src/generation/NarrationWriterBuilder";
import type { ActVerifyRequest, ActVerifyResult } from "../src/generation/NarrationVerifierBuilder";
import type { SourcedAct, TapePointer } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";
import type { ForayItem } from "../src/generation/forayItems";

/**
 * GV-108 (docs/roadmap/generation-v2.md, W5-12b; R2-13, QK-29, GP-26): the
 * cut-to-introduction policy. Under FORAY_UNVERIFIED_SEAM_POLICY=cut a seam
 * the act verifier never confirmed keeps only its introduction sentences,
 * checked in code, as a verified Intro page on the clip it introduces -- or
 * is dropped, its beats recording `droppedReason: "unverified-cut"` and the
 * clips running together. The hand-off line never plays. `keep` (the
 * default) is F-51's policy, unchanged.
 *
 * The fixture is actNarration.test.ts's acceptance shape (one act, four
 * narration beats, two clips from Practical AI), rebuilt here so this suite
 * stands alone. Every test names the mutation that kills it.
 */

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
const ctx: NarrationBuildContext = { userId: "founder-1" };

const ITEM_A = "practical-ai--skills-over-models";
const ITEM_B = "practical-ai--a-robot-in-a-simulator";
const SEGMENT_A = `${ITEM_A}#410`;
const SEGMENT_B = `${ITEM_B}#980`;
const SHOW = "Practical AI";
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

function pointer(itemId: string, segmentId: string, startAnchor: string, startSec: number): TapePointer {
  return { segmentId, itemId, startSec, endSec: startSec + 120, startAnchor, endAnchor: "and each time the fix was a hire", tier: 1, confidence: "high" };
}
const TAPE_A = pointer(ITEM_A, SEGMENT_A, ANCHOR_A, 410);
const TAPE_B = pointer(ITEM_B, SEGMENT_B, ANCHOR_B, 980);

const CLAIMS = {
  b0: "The Hyatt walkway hangers carried double the load the design assumed.",
  b1: "The connection was never checked for adequacy at any stage.",
  b2: "Investigators traced the change to a fabricator's shop drawing.",
  b3: "The as-built connection could carry about sixty percent of the code load."
};

function narration(claim: string, mode: "Patch" | "Carry" = "Patch") {
  return { sourcing: "narration" as const, claim, exploration: false, narration: { mode, reason: "t" } };
}
function tape(claim: string, tapePointer: TapePointer) {
  return { sourcing: "tape" as const, claim, exploration: false, tape: tapePointer };
}

/** s0 {b0, b1} -> c0 (A, full Intro: the first clip from Practical AI);
 * s1 {b3} -> c1 (B, a new episode, full Intro); s2 {b5} after the last clip.
 * `lastMode` sets b5's mode (the failing Carry seam). */
function fourBeatsTwoClips(lastMode: "Patch" | "Carry" = "Patch"): SourcedAct {
  return {
    title: "Act 1: Skills decide the tools",
    slots: [
      { title: "Opening", beats: [narration(CLAIMS.b0), narration(CLAIMS.b1), tape("A guest explains why skills decide the tools.", TAPE_A)] },
      { title: "The turn", beats: [narration(CLAIMS.b2), tape("The robot in the simulator.", TAPE_B), narration(CLAIMS.b3, lastMode)] }
    ]
  };
}

function gatherer(windows: Record<string, string> = { [SEGMENT_A]: WINDOW_A, [SEGMENT_B]: WINDOW_B }): EvidenceGatherer {
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

/** The stub builders with a hook on the writer's reply and one on the
 * verifier's verdict. */
function builders(
  mutate?: (reply: ActWriteResult, request: ActWriteRequest, round: number) => ActWriteResult,
  mutateVerdict?: (verdict: ActVerifyResult, request: ActVerifyRequest, round: number) => ActVerifyResult
) {
  const writer = new StubNarrationWriterBuilder();
  const verifier = new StubNarrationVerifierBuilder();
  const calls = { write: 0, verify: 0 };
  const realWrite = writer.writeAct.bind(writer);
  writer.writeAct = async (request, buildCtx) => {
    calls.write++;
    const reply = await realWrite(request, buildCtx);
    return mutate ? mutate(reply, request, calls.write) : reply;
  };
  const realVerify = verifier.verifyAct.bind(verifier);
  verifier.verifyAct = async (request, buildCtx) => {
    calls.verify++;
    const verdict = await realVerify(request, buildCtx);
    return mutateVerdict ? mutateVerdict(verdict, request, calls.verify) : verdict;
  };
  return { writer, verifier, calls };
}

/** The verifier never finds beat `beatId` carried: its seam is confirmed with
 * a beat of its own missing, every round (the confirmed-but-uncarried case). */
const neverCarried = (beatId: string) => (verdict: ActVerifyResult): ActVerifyResult => ({
  ...verdict,
  beats: verdict.beats.map((b) => (b.beatId === beatId ? { beatId, carried: false, notes: `the prose never carries ${beatId}` } : b))
});
/** The verifier refuses seam `seamId` every round (the salvage case). */
const refusedSeam = (seamId: string) => (verdict: ActVerifyResult): ActVerifyResult => ({
  ...verdict,
  seams: verdict.seams.map((s) => (s.seamId === seamId ? { ...s, claimsSupported: false, notes: `seam ${seamId} overstates its sources` } : s))
});
/** The writer never returns seam `seamId`: no page is ever produced for it
 * (the `no-page` hand-off case). */
const omitSeam = (seamId: string) => (reply: ActWriteResult): ActWriteResult => ({ seams: reply.seams.filter((s) => s.seamId !== seamId) });

const STUB_INTRO_A = `Next, from ${SHOW}, "${TITLE_A}".`;

type NarrationBeat = Extract<WrittenBeat, { sourcing: "narration" }>;
type TapeBeat = Extract<WrittenBeat, { sourcing: "tape" }>;
const beatsOf = (act: WrittenAct): WrittenBeat[] => act.slots.flatMap((s) => s.beats);
const narrationBeats = (act: WrittenAct): NarrationBeat[] => beatsOf(act).filter((b): b is NarrationBeat => b.sourcing === "narration");
const tapeBeats = (act: WrittenAct): TapeBeat[] => beatsOf(act).filter((b): b is TapeBeat => b.sourcing === "tape");
const pagesOf = (act: WrittenAct): NarratedBeat[] => beatsOf(act).map(pageOfWrittenBeat).filter((p): p is NarratedBeat => p !== undefined);

async function run(options: Partial<WriteActOptions>, b: ReturnType<typeof builders>, act: SourcedAct = fourBeatsTwoClips(), buildCtx: NarrationBuildContext = ctx): Promise<WrittenAct> {
  return writeActNarration(act, { writer: b.writer, verifier: b.verifier, evidence: gatherer(), ...options }, voice, buildCtx);
}

const DIGIT_LINE = `That is ${SHOW}, back in 2019.`;
/** Every round, seam s0 opens with a sentence that names the show and states
 * a year (a numeral no window carries). */
const withYearLine = (reply: ActWriteResult): ActWriteResult => ({
  seams: reply.seams.map((seam) => (seam.seamId === "s0" ? { ...seam, script: `${DIGIT_LINE} ${seam.script}` } : seam))
});
const introPage = (act: WrittenAct, clip: number): NarratedBeat | undefined => tapeBeats(act)[clip]!.connectiveNarration;

describe("GV-108 — a failing seam is cut to its code-checked introduction", () => {
  it("cut: a full-intro seam confirmed with a beat it never carries becomes an intro-only verified page on its clip that still names the show (Q-09), and its beats are dropped", async () => {
    /* MUTATION THAT KILLS THIS: drop the `introNamesSource(sentence, brief)`
       clause from cutToIntroduction -- "Listen for who is doing the
       talking." and the beat sentences stay in the page (up to the Intro
       ceiling) and the script is no longer the naming sentence alone. Ran
       it -- red. And: return the confirmed text unverified under `cut` (the
       keep branch) -- b0 holds an unverified page and c0 none. Ran it -- red. */
    const b = builders(undefined, neverCarried("b1"));
    const act = await run({ unverifiedSeamPolicy: "cut" }, b);
    expect(b.calls).toEqual({ write: 3, verify: 3 });

    const intro = introPage(act, 0)!;
    expect(intro).toBeDefined();
    expect(intro.script).toBe(STUB_INTRO_A);
    expect(intro.mode).toBe("Intro");
    expect(introNamesShow(intro.script, { show: SHOW })).toBe(true);
    expect(isIntroOnlyVerified(intro)).toBe(true);
    expect(intro.verification).toEqual({ kind: "intro-only", clipId: "c0" });
    expect(intro.sources).toEqual([expect.objectContaining({ kind: "tape", segmentId: SEGMENT_A, publication: `${SHOW} — ${TITLE_A}` })]);
    expect(intro.cutSentences).toHaveLength(3);
    expect(intro.cutSentences![0]).toBe("Listen for who is doing the talking.");
    expect(intro.verifierNotes!.startsWith(INTRO_CUT_NOTE)).toBe(true);
    expect(intro.attempts).toHaveLength(3);
    expect(intro.evidence!.map((d) => d.docId)).toContain(tapeDocIdFor(SEGMENT_A));
    expect(NarratedBeatSchema.parse(JSON.parse(JSON.stringify(intro)))).toEqual(intro);

    const [b0, b1, b2, b3] = narrationBeats(act);
    for (const beat of [b0!, b1!]) {
      expect(droppedReasonOf(beat)).toBe("unverified-cut");
      expect(beat.narration).toBeUndefined();
      expect(beat.carriedBy).toBeUndefined();
      expect(beat.verifiedAtAttempt).toBeUndefined();
    }
    /* The other seams are untouched: verified, nothing dropped. */
    for (const beat of [b2!, b3!]) {
      expect(beat.narration!.verified).toBe(true);
      expect(droppedReasonOf(beat)).toBeUndefined();
    }
    expect(computeUnverifiedPages([act]).count).toBe(0);
    expect(pagesOf(act).every((p) => p.verified)).toBe(true);
  });

  it("keep (the default): the same seam is kept unverified on its beat, and an omitted policy and `keep` write the same act", async () => {
    /* MUTATION THAT KILLS THIS: treat an omitted policy as `cut`
       (`options.unverifiedSeamPolicy !== "keep"`) -- the default act loses
       b0's page. Ran it -- red. */
    const omitted = await run({}, builders(undefined, neverCarried("b1")));
    const kept = await run({ unverifiedSeamPolicy: "keep" }, builders(undefined, neverCarried("b1")));
    expect(kept).toEqual(omitted);
    const [b0] = narrationBeats(omitted);
    expect(b0!.narration!.verified).toBe(false);
    expect(b0!.narration!.verifierNotes).toMatch(/b1/);
    expect(introPage(omitted, 0)).toBeUndefined();
    expect(narrationBeats(omitted).some((beat) => droppedReasonOf(beat) !== undefined)).toBe(false);
    expect(computeUnverifiedPages([omitted]).count).toBe(1);
  });

  it("cut: a seam the verifier refused every round (F-51's salvage) is cut to its introduction the same way", async () => {
    /* MUTATION THAT KILLS THIS: leave the salvage branch on keep's path
       under `cut` -- b0 keeps the refused draft, unverified. Ran it -- red. */
    const act = await run({ unverifiedSeamPolicy: "cut" }, builders(undefined, refusedSeam("s0")));
    expect(introPage(act, 0)!.script).toBe(STUB_INTRO_A);
    expect(introPage(act, 0)!.verifierNotes).toContain("overstates its sources");
    expect(narrationBeats(act).slice(0, 2).map((beat) => droppedReasonOf(beat))).toEqual(["unverified-cut", "unverified-cut"]);
    expect(computeUnverifiedPages([act]).count).toBe(0);
  });

  it("cut: a failing Carry seam after the last clip introduces nothing, so its beat gets no page; one that never produced prose gets no hand-off, and HANDOFF_SCRIPT appears nowhere", async () => {
    /* MUTATION THAT KILLS THIS: return the hand-off page from finalPageFor's
       no-page branch under `cut` (skip the `if (cut)` block) -- b5 holds
       HANDOFF_SCRIPT. Ran it -- red. And: drop the `if (!introduces)` guard
       in cutToIntroduction -- it throws on the missing clip. Ran it -- red. */
    const control = await run({}, builders(omitSeam("s2")), fourBeatsTwoClips("Carry"));
    expect(narrationBeats(control)[3]!.narration!.script).toBe(HANDOFF_SCRIPT);

    const noProse = await run({ unverifiedSeamPolicy: "cut" }, builders(omitSeam("s2")), fourBeatsTwoClips("Carry"));
    const refused = await run(
      { unverifiedSeamPolicy: "cut" },
      builders(undefined, (verdict) => neverCarried("b5")(refusedSeam("s2")(verdict))),
      fourBeatsTwoClips("Carry")
    );
    for (const act of [noProse, refused]) {
      const b5 = narrationBeats(act)[3]!;
      expect(b5.narration).toBeUndefined();
      expect(droppedReasonOf(b5)).toBe("unverified-cut");
      expect(JSON.stringify(act)).not.toContain(HANDOFF_SCRIPT);
      expect(computeUnverifiedPages([act]).count).toBe(0);
      /* The seams that passed are untouched. */
      expect(narrationBeats(act)[0]!.narration!.verified).toBe(true);
    }
  });

  it("cut: a beat of a cut seam that a seam playing whole carries is still heard -- it keeps its round and is not dropped", async () => {
    /* The stub verifier finds b5's claim ("the as-built connection ...") in
       s0's prose, so when s2 is refused b5 is still carried, by s0.
       MUTATION THAT KILLS THIS: drop the `heardIn` check from assemble's cut
       branch -- b5 is recorded as dropped although s0 plays it. Ran it -- red. */
    const act = await run({ unverifiedSeamPolicy: "cut" }, builders(undefined, refusedSeam("s2")), fourBeatsTwoClips("Carry"));
    const b5 = narrationBeats(act)[3]!;
    expect(b5.narration).toBeUndefined();
    expect(droppedReasonOf(b5)).toBeUndefined();
    expect(b5.verifiedAtAttempt).toBe(1);
    expect(b5.carriedBy).toBeUndefined();
    expect(computeUnverifiedPages([act]).count).toBe(0);
  });

  it("cut: a seam whose only naming sentence leaves a show's first clip unnamed is dropped, not kept unnamed (Q-09)", async () => {
    /* MUTATION THAT KILLS THIS: drop the Q-09 check from cutToIntroduction
       -- "Next, a guest on why skills come first." (it names "Skills" from
       the episode title, so `introNamesSource` passes) is kept before the
       first clip from Practical AI. Ran it -- red. */
    const unnamed = (reply: ActWriteResult): ActWriteResult => ({
      seams: reply.seams.map((seam) => (seam.seamId === "s0" ? { ...seam, script: seam.script.replace(STUB_INTRO_A, "Next, a guest on why skills come first.") } : seam))
    });
    const act = await run({ unverifiedSeamPolicy: "cut" }, builders(unnamed));
    expect(introPage(act, 0)).toBeUndefined();
    expect(narrationBeats(act).slice(0, 2).map((beat) => droppedReasonOf(beat))).toEqual(["unverified-cut", "unverified-cut"]);
    /* Clip c1 is a new episode of the same show: its own page is untouched. */
    expect(narrationBeats(act)[2]!.narration!.verified).toBe(true);
  });

  it("cut composes with the voice gate: where it enforces, a naming sentence with a numeral is cut; under report it is kept", async () => {
    /* MUTATION THAT KILLS THIS: drop the `cut.voiceEnforce` clause from
       cutToIntroduction -- the enforcing act keeps "back in 2019". Ran it -- red. */
    const atAct1: NarrationBuildContext = { ...ctx, actIndex: 1 };
    const enforced = await run({ unverifiedSeamPolicy: "cut", voiceGate: { mode: "enforce", enforceFromAct: 1 } }, builders(withYearLine, neverCarried("b1")), fourBeatsTwoClips(), atAct1);
    expect(introPage(enforced, 0)!.script).toBe(STUB_INTRO_A);
    expect(introPage(enforced, 0)!.cutSentences).toContain(DIGIT_LINE);

    const reported = await run({ unverifiedSeamPolicy: "cut", voiceGate: { mode: "report", enforceFromAct: 1 } }, builders(withYearLine, neverCarried("b1")), fourBeatsTwoClips(), atAct1);
    expect(introPage(reported, 0)!.script).toBe(`${DIGIT_LINE} ${STUB_INTRO_A}`);
  });

  it("cut composes with the specifics gate: under enforce a naming sentence stating a year no window carries is cut; under report it is kept", async () => {
    /* MUTATION THAT KILLS THIS: drop the `cut.specifics === "enforce"`
       clause from cutToIntroduction -- the enforcing run keeps "2019". Ran
       it -- red. */
    const enforced = await run({ unverifiedSeamPolicy: "cut", specifics: "enforce" }, builders(withYearLine, neverCarried("b1")));
    expect(introPage(enforced, 0)!.script).toBe(STUB_INTRO_A);
    expect(introPage(enforced, 0)!.cutSentences).toContain(DIGIT_LINE);

    const reported = await run({ unverifiedSeamPolicy: "cut", specifics: "report" }, builders(withYearLine, neverCarried("b1")));
    expect(introPage(reported, 0)!.script).toBe(`${DIGIT_LINE} ${STUB_INTRO_A}`);
  });

  it("cut: an introduction sentence that repeats the clip's first sentences is cut (Q-02)", async () => {
    /* MUTATION THAT KILLS THIS: drop the `introRestatesClip` clause from the
       sentence filter -- the restating sentence (it names the show) is kept.
       Ran it -- red. */
    const restating = `On ${SHOW}: the mix of skills in the organization decides the tools.`;
    const withRestate = (reply: ActWriteResult): ActWriteResult => ({
      seams: reply.seams.map((seam) => (seam.seamId === "s0" ? { ...seam, script: `${restating} ${seam.script}` } : seam))
    });
    const act = await run({ unverifiedSeamPolicy: "cut" }, builders(withRestate, neverCarried("b1")));
    expect(introPage(act, 0)!.script).toBe(STUB_INTRO_A);
    expect(introPage(act, 0)!.cutSentences).toContain(restating);
  });

  it("cut: an introduction sentence that names the show but leaks the Foray's structure is cut (Q-08)", async () => {
    /* MUTATION THAT KILLS THIS: drop the `narratorStructureLeaks` clause
       from the sentence filter (replace it with `true`) -- the leaking
       sentence names the show, so it is kept in front of the stub
       introduction. Ran it -- red. */
    const leaking = `In this act, ${SHOW} explains the turn.`;
    expect(introNamesShow(leaking, { show: SHOW })).toBe(true);
    const withLeak = (reply: ActWriteResult): ActWriteResult => ({
      seams: reply.seams.map((seam) => (seam.seamId === "s0" ? { ...seam, script: `${leaking} ${seam.script}` } : seam))
    });
    const act = await run({ unverifiedSeamPolicy: "cut" }, builders(withLeak, neverCarried("b1")));
    expect(introPage(act, 0)!.script).toBe(STUB_INTRO_A);
    expect(introPage(act, 0)!.cutSentences).toContain(leaking);
  });
});

describe("GV-108 — the page and beat records", () => {
  it("an intro-only page parses with its cut sentences, is not a synthesis, and an unknown verification kind or an empty cut sentence is refused", () => {
    /* MUTATION THAT KILLS THIS: leave `verification` as the synthesis
       schema alone (or drop `cutSentences` from NarratedBeatSchema) -- the
       intro-only page fails to parse, and a resumed `narrate:<i>` with one
       throws. Ran it -- red. */
    const page: NarratedBeat = {
      mode: "Intro",
      script: STUB_INTRO_A,
      sources: [{ kind: "tape", segmentId: SEGMENT_A, claimText: "the clip", publication: `${SHOW} — ${TITLE_A}`, contested: false }],
      pronunciationHints: [],
      verified: true,
      verification: { kind: "intro-only", clipId: "c0" },
      cutSentences: ["Listen for who is doing the talking."]
    };
    expect(NarratedBeatSchema.parse(page)).toEqual(page);
    expect(isIntroOnlyVerified(page)).toBe(true);
    expect(isSynthesisVerified(page)).toBe(false);
    expect(isIntroOnlyVerified({ ...page, verified: false })).toBe(false);
    expect(computeSynthesisVerifiedPages([{ title: "t", slots: [{ title: "s", beats: [{ sourcing: "tape", claim: "c", exploration: false, tape: TAPE_A, connectiveNarration: page }] }] }]).count).toBe(0);
    expect(NarratedBeatSchema.safeParse({ ...page, verification: { kind: "trust-me", clipId: "c0" } }).success).toBe(false);
    expect(NarratedBeatSchema.safeParse({ ...page, verification: { kind: "intro-only" } }).success).toBe(false);
    expect(NarratedBeatSchema.safeParse({ ...page, cutSentences: [""] }).success).toBe(false);
    /* A synthesis still parses unchanged. */
    expect(NarratedBeatSchema.safeParse({ ...page, mode: "Hinge", verification: { kind: "synthesis", restsOn: ["p1"], attempt: 1 } }).success).toBe(true);
  });

  it("droppedReasonOf reads the beat's reason and nothing else", () => {
    /* MUTATION THAT KILLS THIS: return the raw field unchecked -- an unknown
       reason reads as a drop. Ran it -- red. */
    expect(droppedReasonOf({ droppedReason: "unverified-cut" })).toBe("unverified-cut");
    expect(droppedReasonOf({ droppedReason: "bored" })).toBeUndefined();
    expect(droppedReasonOf({})).toBeUndefined();
  });

  it("cutSentences is an internal-only field: a mapped item carrying it is refused", () => {
    /* MUTATION THAT KILLS THIS: leave "cutSentences" off
       INTERNAL_ONLY_FIELD_NAMES. Ran it -- red. */
    expect(INTERNAL_ONLY_FIELD_NAMES).toContain("cutSentences");
    const item = { type: "narration", id: "n1", mode: "intro", script: STUB_INTRO_A, cutSentences: ["x"] } as unknown as ForayItem;
    expect(() => assertNoInternalFieldsLeaked([item])).toThrow(/cutSentences/);
  });
});

describe("GV-108 — FORAY_UNVERIFIED_SEAM_POLICY", () => {
  it("defaults to keep, reads cut, and refuses anything else naming the variable", () => {
    /* MUTATION THAT KILLS THIS: default the row to `cut`, or drop the row
       from GATE_TABLE (the env is ignored and `cut` reads as undefined).
       Ran both -- red. */
    expect(readGateConfig({}).unverifiedSeamPolicy).toBe("keep");
    expect(readGateConfig({ FORAY_UNVERIFIED_SEAM_POLICY: "cut" }).unverifiedSeamPolicy).toBe("cut");
    expect(resolveGateConfig({ unverifiedSeamPolicy: "cut" }, {}).unverifiedSeamPolicy).toBe("cut");
    expect(() => readGateConfig({ FORAY_UNVERIFIED_SEAM_POLICY: "drop" })).toThrow(/FORAY_UNVERIFIED_SEAM_POLICY/);
    expect(GATE_TABLE.find((e) => e.key === "unverifiedSeamPolicy")).toMatchObject({ env: "FORAY_UNVERIFIED_SEAM_POLICY", default: "keep" });
  });
});

describe("GV-108 — the report counts cut pages apart from dropped ones", () => {
  it("pagesCut counts an intro-only page and a seam dropped whole; a clip whose seam was cut is not a dropped page; buildVeracityMetrics reports pagesCut only under cut", async () => {
    /* MUTATION THAT KILLS THIS: drop `cutBefore` from computePagesDropped --
       the clip after the dropped seam s1 counts as a dropped page. Ran it --
       red. And: report `pagesCut` unconditionally -- the default report
       gains a key. Ran it -- red. */
    const s1Unnamed = (reply: ActWriteResult): ActWriteResult => ({
      seams: reply.seams.map((seam) => (seam.seamId === "s1" ? { ...seam, script: seam.script.replace(/Next, from [^.]*\. ?/, "") } : seam))
    });
    const sourced = fourBeatsTwoClips();
    const act = await run({ unverifiedSeamPolicy: "cut" }, builders(s1Unnamed, neverCarried("b1")), sourced);
    /* s0 cut to its introduction, s1 dropped whole (no naming sentence). */
    expect(introPage(act, 0)!.verification).toEqual({ kind: "intro-only", clipId: "c0" });
    expect(introPage(act, 1)).toBeUndefined();
    expect(droppedReasonOf(narrationBeats(act)[2]!)).toBe("unverified-cut");
    expect(computePagesCut([act])).toBe(2);
    expect(computePagesDropped([sourced], [act])).toBe(0);
    /* Today's act cuts nothing. */
    const kept = await run({}, builders(s1Unnamed, neverCarried("b1")), sourced);
    expect(computePagesCut([kept])).toBe(0);

    const input = { sourcedActs: [sourced], writtenActs: [act], topic: "engineering-disasters", writerCalls: 3, verifierCalls: 3, pipelineTokens: 0, stageTimings: [], tapeRelevanceRows: [] };
    expect(buildVeracityMetrics({ ...input, unverifiedSeamPolicy: "cut" }).pagesCut).toBe(2);
    expect(Object.prototype.hasOwnProperty.call(buildVeracityMetrics(input), "pagesCut")).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(buildVeracityMetrics({ ...input, unverifiedSeamPolicy: "keep" }), "pagesCut")).toBe(false);
  });

  it("computeUnverifiedPages ignores a dropped beat, since nothing plays for it", () => {
    /* MUTATION THAT KILLS THIS: count every page (drop the `heard` filter)
       -- a dropped beat holding an unverified page is counted. Ran it -- red. */
    const unverified: NarratedBeat = { mode: "Patch", script: "x".repeat(400), sources: [], pronunciationHints: [], verified: false };
    const act: WrittenAct = {
      title: "t",
      slots: [
        {
          title: "s",
          beats: [
            { sourcing: "narration", claim: "dropped", exploration: false, narration: unverified, droppedReason: "unverified-cut" },
            { sourcing: "narration", claim: "heard", exploration: false, narration: unverified }
          ]
        }
      ]
    };
    const result = computeUnverifiedPages([act]);
    expect(result.count).toBe(1);
    expect(result.pages[0]!.claim).toBe("heard");
  });
});
