import { describe, it, expect } from "vitest";
import { pageOfWrittenBeat, writeNarration, type WrittenAct, type WrittenBeat } from "../src/generation/writeNarration";
import { SENTENCE_CUT_NOTE, writeActNarration, type WriteActOptions, type WriterExchange } from "../src/generation/writeAct";
import { seamBand } from "../src/generation/actSeams";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { GATE_TABLE, readGateConfig, resolveGateConfig } from "../src/generation/gateConfig";
import { assertNoInternalFieldsLeaked, toForayItems } from "../src/generation/forayItems";
import { stitchAct } from "../src/generation/stitchAct";
import { computeSentencesSurviving } from "../src/generation/veracityMetrics";
import { splitSpokenSentences } from "../src/copy/spokenLine";
import { droppedReasonOf, isStatementSentence, tapeDocIdFor, type NarratedBeat } from "../src/types/narration";
import type { EvidenceBeat, EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type { ActWriteRequest, ActWriteResult, NarrationBuildContext } from "../src/generation/NarrationWriterBuilder";
import type { ActVerifyRequest, ActVerifyResult, SentenceVerdict } from "../src/generation/NarrationVerifierBuilder";
import type { SourcedAct, TapePointer } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";

/**
 * GV-113 (docs/roadmap/generation-v2.md, W5-11; R2-10, MQ-02, MQ-11, GP-26):
 * cut unsupported sentences instead of rewriting. Under
 * FORAY_UNSUPPORTED_SENTENCE_POLICY=cut a seam whose per-sentence verdicts
 * mark some, but not all, of its statements unsupported is trimmed of them in
 * code and confirmed in the same round (no writer call); only a beat the cut
 * leaves uncarried re-opens a seam, for exactly one more writer round. The
 * default `rewrite` is today's writer.
 *
 * The fixture is actNarration.test.ts's acceptance shape (one act, four
 * narration beats, two clips from Practical AI: s0 {b0, b1} -> c0, s1 {b3} ->
 * c1, s2 {b5} after the last clip), rebuilt here so this suite stands alone
 * (introCut.test.ts's pattern). The verifier is the stub wrapped with W5-09's
 * sentence contract: the wrapper attaches `SeamVerdict.sentences` to the
 * seams it is told about. Every test names the mutation that kills it.
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

function fourBeatsTwoClips(): SourcedAct {
  return {
    title: "Act 1: Skills decide the tools",
    slots: [
      { title: "Opening", beats: [narration(CLAIMS.b0), narration(CLAIMS.b1), tape("A guest explains why skills decide the tools.", TAPE_A)] },
      { title: "The turn", beats: [narration(CLAIMS.b2), tape("The robot in the simulator.", TAPE_B), narration(CLAIMS.b3)] }
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

/** The stub builders with a hook on the writer's reply and one on the
 * verifier's verdict, counting the calls and keeping every request. */
function builders(
  mutate?: (reply: ActWriteResult, request: ActWriteRequest, round: number) => ActWriteResult,
  mutateVerdict?: (verdict: ActVerifyResult, request: ActVerifyRequest, round: number) => ActVerifyResult
) {
  const writer = new StubNarrationWriterBuilder();
  const verifier = new StubNarrationVerifierBuilder();
  const calls = { write: 0, verify: 0 };
  const writes: ActWriteRequest[] = [];
  const verifies: ActVerifyRequest[] = [];
  const realWrite = writer.writeAct.bind(writer);
  writer.writeAct = async (request, buildCtx) => {
    calls.write++;
    writes.push(request);
    const reply = await realWrite(request, buildCtx);
    return mutate ? mutate(reply, request, calls.write) : reply;
  };
  const realVerify = verifier.verifyAct.bind(verifier);
  verifier.verifyAct = async (request, buildCtx) => {
    calls.verify++;
    verifies.push(request);
    const verdict = await realVerify(request, buildCtx);
    return mutateVerdict ? mutateVerdict(verdict, request, calls.verify) : verdict;
  };
  return { writer, verifier, calls, writes, verifies };
}

/* ------------------------------------------------------------------ */
/* Seam s2 {b5}, written by hand: three statements                       */
/* ------------------------------------------------------------------ */

/** Carries b5 ("The as-built connection could carry about sixty percent of
 * the code load."). */
const S2_CARRY = "The connection as it was built could hold only about sixty percent of the load the Kansas City code required.";
/** The sentence the verifier refuses: nothing in the act says it. */
const S2_UNSUPPORTED =
  "Inspectors who walked the atrium later said the welds had failed in several places long before the collapse, and that nobody had reported the cracks to the owners.";
/** Shares no content word with b5's claim. */
const S2_TRACED = "Investigators traced the change back to a shop drawing that the fabricator produced and that was approved without any calculation.";
const S2_SCRIPT = `${S2_CARRY} ${S2_UNSUPPORTED} ${S2_TRACED}`;

/** The writer always writes s2 as `script` (by round, when a function). */
const s2Writes = (script: string | ((round: number) => string)) => (reply: ActWriteResult, _request: ActWriteRequest, round: number): ActWriteResult => ({
  seams: reply.seams.map((seam) => (seam.seamId === "s2" ? { ...seam, script: typeof script === "string" ? script : script(round) } : seam))
});

interface SentencePlan {
  /** The seam the verdicts are attached to. */
  seamId: string;
  /** A statement the judge refuses (by sentence text, and verify round). */
  unsupported: (text: string, round: number) => boolean;
  /** A statement the judge could not answer. */
  unknown?: (text: string) => boolean;
  /** Treat a sentence as a statement even if it does not read as one. */
  statement?: (text: string) => boolean;
  /** How the verifier says beat `beatId` is carried by the seam: by the
   * sentence `sentence` picks (`carriedBySentence`), or by the seam alone. */
  carrier?: { beatId: string; sentence?: (text: string) => boolean };
  /** The ids a supported statement rests on (default: every source the
   * seam selected). */
  restsOn?: (selected: string[]) => string[];
}

/** W5-09's contract on the stub: `SeamVerdict.sentences` for one seam, and
 * the seam's own answer derived from them as the Jev verifier does
 * (claimsSupported only when every statement is supported). */
const withSentences = (plan: SentencePlan) => (verdict: ActVerifyResult, request: ActVerifyRequest, round: number): ActVerifyResult => {
  const brief = request.seams.find((s) => s.seamId === plan.seamId);
  if (!brief) return verdict;
  const sentences: SentenceVerdict[] = splitSpokenSentences(brief.script).map((text, index) => {
    const statement = plan.statement?.(text) === true || isStatementSentence(text);
    if (!statement) return { index, text, kind: "imperative", verdict: "exempt" };
    if (plan.unsupported(text, round)) return { index, text, kind: "statement", verdict: "unsupported" };
    if (plan.unknown?.(text)) return { index, text, kind: "statement", verdict: "unknown" };
    return { index, text, kind: "statement", verdict: "supported", restsOn: plan.restsOn ? plan.restsOn(brief.selected) : [...brief.selected] };
  });
  const failing = sentences.filter((s) => s.kind === "statement" && s.verdict !== "supported");
  const carrierAt = plan.carrier?.sentence ? sentences.findIndex((s) => plan.carrier!.sentence!(s.text)) : -1;
  return {
    beats: verdict.beats.map((b) =>
      plan.carrier && b.beatId === plan.carrier.beatId
        ? { beatId: b.beatId, carried: true, carriedBy: plan.seamId, restsOn: [...brief.selected], ...(carrierAt >= 0 ? { carriedBySentence: { seamId: plan.seamId, index: carrierAt } } : {}) }
        : b
    ),
    seams: verdict.seams.map((seam) =>
      seam.seamId === plan.seamId
        ? {
            ...seam,
            sentences,
            claimsSupported: failing.length === 0,
            ...(failing.length > 0 ? { notes: failing.map((s) => `Unsupported: "${s.text}" is not backed by any source in the act.`).join(" ") } : {})
          }
        : seam
    )
  };
};

/** s2 with S2_UNSUPPORTED refused, b5 carried by its first sentence. */
const BASE_PLAN: SentencePlan = {
  seamId: "s2",
  unsupported: (text) => text === S2_UNSUPPORTED,
  carrier: { beatId: "b5", sentence: (text) => text === S2_CARRY }
};

type NarrationBeat = Extract<WrittenBeat, { sourcing: "narration" }>;
const beatsOf = (act: WrittenAct): WrittenBeat[] => act.slots.flatMap((s) => s.beats);
const narrationBeats = (act: WrittenAct): NarrationBeat[] => beatsOf(act).filter((b): b is NarrationBeat => b.sourcing === "narration");
const pagesOf = (act: WrittenAct): NarratedBeat[] => beatsOf(act).map(pageOfWrittenBeat).filter((p): p is NarratedBeat => p !== undefined);
/** b5's page: the last narration beat's. */
const s2Page = (act: WrittenAct): NarratedBeat | undefined => narrationBeats(act)[3]!.narration;

async function run(options: Partial<WriteActOptions>, b: ReturnType<typeof builders>): Promise<WrittenAct> {
  return writeActNarration(fourBeatsTwoClips(), { writer: b.writer, verifier: b.verifier, evidence: gatherer(), ...options }, voice, ctx);
}

describe("GV-113 — an unsupported sentence is cut in code, not rewritten", () => {
  it("sentence 2 of 3 unsupported: round 1 confirms the trimmed seam, the writer is called once, and cutSentences holds the removed sentence", async () => {
    /* MUTATION THAT KILLS THIS: drop the cut branch from judge() (never call
       cutUnsupportedSentences) -- s2 is refused, the writer is asked twice
       more and the page is unverified with no cutSentences. Ran it -- red. */
    const exchanges: WriterExchange[] = [];
    const b = builders(s2Writes(S2_SCRIPT), withSentences(BASE_PLAN));
    const act = await run({ sentencePolicy: "cut", onExchange: (e) => exchanges.push(e) }, b);
    expect(b.calls.write).toBe(1);
    expect(b.calls.verify).toBe(1);
    const page = s2Page(act)!;
    expect(page.script).toBe(`${S2_CARRY} ${S2_TRACED}`);
    expect(page.verified).toBe(true);
    expect(page.cutSentences).toEqual([S2_UNSUPPORTED]);
    expect(page.verifierNotes).toBe(`1 ${SENTENCE_CUT_NOTE}, round 1`);
    expect(page.attempts).toEqual([expect.objectContaining({ attempt: 1, rejected: false })]);
    expect(narrationBeats(act)[3]!.verifiedAtAttempt).toBe(1);
    /* GV-110: a cut round is still one round, one exchange. */
    expect(exchanges.map((e) => e.round)).toEqual([1]);
    /* Every other page is today's: verified, nothing cut. */
    expect(pagesOf(act).filter((p) => p !== page).every((p) => p.verified && p.cutSentences === undefined)).toBe(true);
  });

  it("a trimmed seam under seamBand's floor passes: only the floor is relaxed", async () => {
    /* MUTATION THAT KILLS THIS: drop `charBandOverride` from the trimmed
       seam's validateSeam call -- the 242-character seam trips the Patch
       floor (340), the cut is refused and the writer is re-asked. Ran it --
       red. */
    const [floor] = seamBand({ beats: [{ mode: "Patch" }] as never, introduces: undefined });
    const trimmed = `${S2_CARRY} ${S2_TRACED}`;
    expect(trimmed.length).toBeLessThan(floor);
    expect(S2_SCRIPT.length).toBeGreaterThanOrEqual(floor);
    const b = builders(s2Writes(S2_SCRIPT), withSentences(BASE_PLAN));
    const act = await run({ sentencePolicy: "cut" }, b);
    expect(s2Page(act)!.script).toBe(trimmed);
    expect(b.calls.write).toBe(1);
  });

  it("a trimmed full-intro seam that loses the show name is refused by Q-09 as before, and the writer is asked instead", async () => {
    /* s0 introduces c0, the first clip this Foray plays from Practical AI.
       The verifier refuses its naming sentence, so the trimmed seam never
       says the show's name.
       MUTATION THAT KILLS THIS: ignore validateSeam's issues on the trimmed
       seam (commit it whatever they are) -- s0 is confirmed without the
       show's name in round 1 with one writer call. Ran it -- red. */
    const naming = (text: string) => text.startsWith("Next, from");
    const b = builders(undefined, withSentences({ seamId: "s0", unsupported: naming, statement: naming }));
    const act = await run({ sentencePolicy: "cut" }, b);
    expect(b.calls.write).toBe(3);
    expect(pagesOf(act).every((p) => p.cutSentences === undefined)).toBe(true);
    const s0 = narrationBeats(act)[0]!.narration!;
    expect(s0.verified).toBe(false);
    expect(s0.script).toContain(`Next, from ${SHOW}`);
  });

  it("every statement unsupported, or an unanswered statement surviving: the rewrite path, deep-equal to the rewrite policy", async () => {
    /* MUTATION THAT KILLS THIS: drop the `indexes.size === statements.length`
       clause (an all-unsupported seam is trimmed to its non-statements) or
       the unknown-survivor clause (an unconfirmed statement is confirmed by
       the cut). Ran both -- red. */
    const allBad: SentencePlan = { seamId: "s2", unsupported: (text) => isStatementSentence(text) };
    const unknownLeft: SentencePlan = { seamId: "s2", unsupported: (text) => text === S2_UNSUPPORTED, unknown: (text) => text === S2_TRACED };
    /* With every statement refused, only the question would be left: the
       cut never leaves a seam that asserts nothing in place of one that
       asserted only what nothing supports. */
    const withQuestion = `${S2_SCRIPT} So who signed off on that change?`;
    for (const plan of [allBad, unknownLeft]) {
      const cut = builders(s2Writes(withQuestion), withSentences(plan));
      const cutAct = await run({ sentencePolicy: "cut" }, cut);
      const rewrite = builders(s2Writes(withQuestion), withSentences(plan));
      const rewriteAct = await run({}, rewrite);
      expect(cut.calls.write).toBe(3);
      expect(cutAct).toEqual(rewriteAct);
      expect(s2Page(cutAct)!.verified).toBe(false);
    }
  });

  it("claims no surviving statement rests on are pruned from the seam's draft", async () => {
    /* s2 selects two print claims; the surviving statements rest on the
       first only, so after the cut the act's source set lists one s2 claim
       (seen in round 2's verify request, which s1's one refusal causes).
       MUTATION THAT KILLS THIS: keep every draft claim on the trimmed seam
       (no pruning) -- round 2's sources list both s2 claims. Ran it -- red. */
    const secondQuote = "Investigators traced the change to a shop drawing produced by the fabricator";
    const twoClaims = (reply: ActWriteResult, request: ActWriteRequest, round: number): ActWriteResult => {
      const scripted = s2Writes(S2_SCRIPT)(reply, request, round);
      return {
        seams: scripted.seams.map((seam) =>
          seam.seamId === "s2" ? { ...seam, claims: [...seam.claims, { claimText: CLAIMS.b2, quote: secondQuote, docId: NBS.docId, contested: false }], usedClaims: [0, 1] } : seam
        )
      };
    };
    const refuseS1Once = (verdict: ActVerifyResult, request: ActVerifyRequest, round: number): ActVerifyResult => {
      const sentenced = withSentences({ ...BASE_PLAN, restsOn: (selected) => selected.slice(0, 1) })(verdict, request, round);
      return round === 1 ? { ...sentenced, seams: sentenced.seams.map((s) => (s.seamId === "s1" ? { ...s, claimsSupported: false, notes: "refused once" } : s)) } : sentenced;
    };
    const b = builders(twoClaims, refuseS1Once);
    const act = await run({ sentencePolicy: "cut" }, b);
    const s2Selected = (request: ActVerifyRequest) => request.sources.filter((s) => s.selectedBy === "s2");
    expect(s2Selected(b.verifies[0]!)).toHaveLength(2);
    expect(b.verifies).toHaveLength(2);
    expect(s2Selected(b.verifies[1]!)).toHaveLength(1);
    expect(s2Selected(b.verifies[1]!)[0]!.quote).not.toBe(secondQuote);
    expect(s2Page(act)!.cutSentences).toEqual([S2_UNSUPPORTED]);
  });
});

describe("GV-113 — beat coverage after a cut (MQ-11): only an orphaned beat earns one more round", () => {
  it("a beat whose carrying sentence was cut re-opens its seam for exactly one more writer round, never a third", async () => {
    /* The writer writes the same s2 every round and the verifier refuses the
       same sentence, which is the one that carries b5: each round's cut
       orphans b5.
       MUTATION THAT KILLS THIS: drop the `orphanSpent` skip from roundNotes
       -- round 2's orphan sends the act back a third time. Ran it -- red.
       And: read only `scriptIsAboutPurpose`, never `carriedBySentence` --
       the trimmed text still shares a word with b5's claim, b5 stays carried
       and the writer is called once. Ran it -- red. */
    const plan: SentencePlan = { seamId: "s2", unsupported: (text) => text === S2_CARRY, carrier: { beatId: "b5", sentence: (text) => text === S2_CARRY } };
    /* The kept sentences still name "the connection", so by the code test
       alone the trimmed text would still carry b5: only the named sentence
       tells the cut that b5 lost its carrier. */
    const examined = "The connection was examined twice more, and the inspectors who walked the atrium wrote down what they saw in their reports.";
    const b = builders(s2Writes(`${S2_CARRY} ${S2_TRACED} ${examined}`), withSentences(plan));
    const act = await run({ sentencePolicy: "cut" }, b);
    expect(b.calls.write).toBe(2);
    const s2Brief = b.writes[1]!.seams.find((s) => s.seamId === "s2")!;
    expect(s2Brief.notes).toContain("beat b5");
    expect(s2Brief.previousScript).not.toContain(S2_CARRY);
    /* After the one round the trimmed text stands and b5's fate is the
       unverified-seam policy's (keep: the page names it, unverified). */
    const page = s2Page(act)!;
    expect(page.cutSentences).toEqual([S2_CARRY]);
    expect(page.verified).toBe(false);
    expect(page.verifierNotes).toContain("b5");
  });

  it("without a sentence named, a beat is re-opened only when the trimmed script no longer shares a word with its claim", async () => {
    /* MUTATION THAT KILLS THIS: re-open every beat the trimmed seam carried
       (drop the scriptIsAboutPurpose test) -- the second case asks the
       writer again. Ran it -- red. And: re-open none -- the first case is
       confirmed with one writer call. Ran it -- red. */
    const lost = builders(s2Writes(S2_SCRIPT), withSentences({ seamId: "s2", unsupported: (text) => text === S2_CARRY, carrier: { beatId: "b5" } }));
    await run({ sentencePolicy: "cut" }, lost);
    expect(lost.calls.write).toBe(2);

    const kept = builders(s2Writes(S2_SCRIPT), withSentences({ seamId: "s2", unsupported: (text) => text === S2_UNSUPPORTED, carrier: { beatId: "b5" } }));
    const act = await run({ sentencePolicy: "cut" }, kept);
    expect(kept.calls.write).toBe(1);
    expect(s2Page(act)!.verified).toBe(true);
  });

  it("a second beat orphaned by a cut in the edit round earns nothing: a two-beat seam gets no third writer round", async () => {
    /* s0 carries b0 and b1. Round 1's cut removes b0's carrier, so s0 earns
       its one edit round; round 2's cut removes b1's carrier. b1 is stamped
       with the round s0's edit was earned in, so it is spent at once: no
       note, and s0 freezes with round 2's trimmed text.
       MUTATION THAT KILLS THIS: stamp a newly orphaned beat with the current
       round even when its seam already spent its edit round
       (`state.orphanedAt ??= round`) -- b1's note sends the act back a third
       time. Ran it -- red. */
    const S0_B0 = "The walkway hangers at the Hyatt ended up carrying double the load that the original design had assumed for them.";
    const S0_B1 = "Nobody ever checked that connection for adequacy, not once, at any stage of the design or the construction.";
    const s0Writes = (reply: ActWriteResult): ActWriteResult => ({
      seams: reply.seams.map((seam) => (seam.seamId === "s0" ? { ...seam, script: `${S0_B0} ${S0_B1} ${seam.script}` } : seam))
    });
    const refuse = (verdict: ActVerifyResult, request: ActVerifyRequest, round: number): ActVerifyResult => {
      const brief = request.seams.find((s) => s.seamId === "s0");
      if (!brief) return verdict;
      const refused = round === 1 ? S0_B0 : S0_B1;
      const sentences: SentenceVerdict[] = splitSpokenSentences(brief.script).map((text, index) =>
        !isStatementSentence(text)
          ? { index, text, kind: "imperative", verdict: "exempt" }
          : text === refused
            ? { index, text, kind: "statement", verdict: "unsupported" }
            : { index, text, kind: "statement", verdict: "supported", restsOn: [...brief.selected] }
      );
      const carrierOf: Record<string, string> = { b0: S0_B0, b1: S0_B1 };
      return {
        beats: verdict.beats.map((b) => {
          const carrier = carrierOf[b.beatId];
          if (carrier === undefined) return b;
          const index = sentences.findIndex((s) => s.text === carrier);
          return { beatId: b.beatId, carried: true, carriedBy: "s0", restsOn: [...brief.selected], ...(index >= 0 ? { carriedBySentence: { seamId: "s0", index } } : {}) };
        }),
        seams: verdict.seams.map((seam) =>
          seam.seamId === "s0" ? { ...seam, sentences, claimsSupported: false, notes: `Unsupported: "${refused}" is not backed by any source in the act.` } : seam
        )
      };
    };
    const b = builders(s0Writes, refuse);
    const act = await run({ sentencePolicy: "cut" }, b);
    expect(b.calls.write).toBe(2);
    /* Round 2 re-asked s0 for b0 alone. */
    const s0Brief = b.writes[1]!.seams.find((s) => s.seamId === "s0")!;
    expect(s0Brief.notes).toContain("beat b0");
    const s0Page = narrationBeats(act)[0]!.narration!;
    expect(s0Page.cutSentences).toEqual([S0_B1]);
    expect(s0Page.script).toContain(S0_B0);
    expect(s0Page.verified).toBe(false);
  });

  it("an edit round that ends unconfirmed puts the trimmed text back, and it stands: no third round", async () => {
    /* Round 2's s2 asserts only what nothing supports, so it is refused.
       MUTATION THAT KILLS THIS: drop holdOrphanEdits -- the refused s2 is a
       note, and the act goes back a third time with the round-2 text kept as
       the unverified salvage. Ran it -- red. */
    const round2 = "Every inspector who ever walked that atrium said the welds were rotten from the very first day the hotel opened its doors to guests.";
    const plan: SentencePlan = {
      seamId: "s2",
      unsupported: (text, round) => text === S2_CARRY || (round === 2 && text === round2),
      carrier: { beatId: "b5", sentence: (text) => text === S2_CARRY }
    };
    const b = builders(s2Writes((round) => (round === 1 ? S2_SCRIPT : round2)), withSentences(plan));
    const act = await run({ sentencePolicy: "cut" }, b);
    expect(b.calls.write).toBe(2);
    const page = s2Page(act)!;
    expect(page.script).toBe(`${S2_UNSUPPORTED} ${S2_TRACED}`);
    expect(page.cutSentences).toEqual([S2_CARRY]);
  });

  it("the orphaned beat's fate follows the unverified-seam policy: under cut it is dropped, nothing unverified plays", async () => {
    /* MUTATION THAT KILLS THIS: count a spent orphan as settled in
       finalPageFor's `uncarried` filter -- the trimmed seam plays as a
       verified page with b5 never carried. Ran it -- red. */
    const plan: SentencePlan = { seamId: "s2", unsupported: (text) => text === S2_CARRY, carrier: { beatId: "b5", sentence: (text) => text === S2_CARRY } };
    const b = builders(s2Writes(S2_SCRIPT), withSentences(plan));
    const act = await run({ sentencePolicy: "cut", unverifiedSeamPolicy: "cut" }, b);
    expect(b.calls.write).toBe(2);
    expect(droppedReasonOf(narrationBeats(act)[3]!)).toBe("unverified-cut");
    expect(s2Page(act)).toBeUndefined();
    expect(pagesOf(act).every((p) => p.verified)).toBe(true);
  });
});

describe("GV-113 — the rewrite policy and the records", () => {
  it("rewrite (the default) is today's writer: omitted and `rewrite` are deep-equal, the seam is re-asked and nothing is cut", async () => {
    /* MUTATION THAT KILLS THIS: cut whatever the policy (test
       `sentencePolicy !== "rewrite"`, or drop the test) -- the default act
       carries cutSentences after one writer call. Ran it -- red. */
    const omitted = builders(s2Writes(S2_SCRIPT), withSentences(BASE_PLAN));
    const omittedAct = await run({}, omitted);
    const rewrite = builders(s2Writes(S2_SCRIPT), withSentences(BASE_PLAN));
    const rewriteAct = await run({ sentencePolicy: "rewrite" }, rewrite);
    expect(omittedAct).toEqual(rewriteAct);
    expect(omitted.calls.write).toBe(3);
    expect(pagesOf(omittedAct).every((p) => p.cutSentences === undefined)).toBe(true);
    expect(s2Page(omittedAct)!.verified).toBe(false);
  });

  it("writeNarration hands the policy to every act", async () => {
    /* MUTATION THAT KILLS THIS: drop the `sentencePolicy` spread from
       writeNarration's writeActNarration options -- the act is written
       under rewrite. Ran it -- red. */
    const b = builders(s2Writes(S2_SCRIPT), withSentences(BASE_PLAN));
    const [act] = await writeNarration([fourBeatsTwoClips()], { writer: b.writer, verifier: b.verifier, evidence: gatherer(), sentencePolicy: "cut" }, voice, ctx);
    expect(b.calls.write).toBe(1);
    expect(s2Page(act!)!.cutSentences).toEqual([S2_UNSUPPORTED]);
  });

  it("toForayItems never carries cutSentences, and the surviving-sentence count reads the pages", async () => {
    /* MUTATION THAT KILLS THIS: commit the trimmed draft with the writer's
       untrimmed script (`script: draft.script` in cutUnsupportedSentences)
       -- the cut sentence reaches the listener's items. Ran it -- red. And:
       count the cut sentences as surviving in computeSentencesSurviving.
       Ran it -- red. (`cutSentences` itself never reaches a stitched item;
       GV-108's INTERNAL_ONLY_FIELD_NAMES guard is asserted on the output.) */
    const b = builders(s2Writes(S2_SCRIPT), withSentences(BASE_PLAN));
    const act = await run({ sentencePolicy: "cut" }, b);
    const items = toForayItems(stitchAct(act, "Act 1").items);
    expect(() => assertNoInternalFieldsLeaked(items)).not.toThrow();
    expect(JSON.stringify(items)).not.toContain("cutSentences");
    expect(JSON.stringify(items)).not.toContain(S2_UNSUPPORTED);
    const surviving = pagesOf(act).reduce((n, p) => n + splitSpokenSentences(p.script).length, 0);
    expect(computeSentencesSurviving([act])).toEqual({ surviving, cut: 1, rate: surviving / (surviving + 1) });
  });

  it("FORAY_UNSUPPORTED_SENTENCE_POLICY defaults to rewrite, reads cut, and refuses anything else naming the variable", () => {
    /* MUTATION THAT KILLS THIS: default the GATE_TABLE row to `cut`, or drop
       the row (the env is ignored and `cut` reads as undefined). Ran both --
       red. */
    expect(readGateConfig({}).sentencePolicy).toBe("rewrite");
    expect(readGateConfig({ FORAY_UNSUPPORTED_SENTENCE_POLICY: "cut" }).sentencePolicy).toBe("cut");
    expect(resolveGateConfig({ sentencePolicy: "cut" }, {}).sentencePolicy).toBe("cut");
    expect(() => readGateConfig({ FORAY_UNSUPPORTED_SENTENCE_POLICY: "trim" })).toThrow(/FORAY_UNSUPPORTED_SENTENCE_POLICY/);
    expect(GATE_TABLE.find((e) => e.key === "sentencePolicy")).toMatchObject({ env: "FORAY_UNSUPPORTED_SENTENCE_POLICY", default: "rewrite" });
  });
});
