import { describe, it, expect } from "vitest";
import { writeNarration, allWrittenNarration, pageOfWrittenBeat, type WrittenAct } from "../src/generation/writeNarration";
import { writeActNarration, actDocuments, titlesForClip } from "../src/generation/writeAct";
import {
  CLIP_FIRST_SENTENCES_WORDS,
  CLIP_OPENING_WORDS,
  HOST_INTRO_PATTERNS,
  INTRO_RESTATE_RUN_WORDS,
  SEAM_MAX_CHARS,
  clipOpening,
  decideIntro,
  hostIntroducesGuest,
  introNamesSource,
  introRestatesClip,
  planActSeams,
  seamBand,
  seamMode
} from "../src/generation/actSeams";
import { StubNarrationWriterBuilder, stubSeam } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder, actVerdictFor } from "../src/generation/StubNarrationVerifierBuilder";
import { buildActWritePrompt } from "../src/generation/AnthropicNarrationWriterBuilder";
import { buildActVerifyPrompt } from "../src/generation/AnthropicNarrationVerifierBuilder";
import { stitchAct } from "../src/generation/stitchAct";
import {
  buildVeracityMetrics,
  computeFirstAttemptPassRate,
  computeIntroRestates,
  computeListeningShares,
  computeNarrationCallsPerAct,
  computeNarrationPagesPerSeam,
  computePagesDropped,
  computeUnverifiedPages
} from "../src/generation/veracityMetrics";
import { MODE_CHAR_BANDS, TAPE_SOURCE_MODES, tapeDocIdFor, validateNarratedBeat, type NarratedBeat } from "../src/types/narration";
import type { EvidenceBeat, EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type { ActWriteRequest, ActWriteResult, NarrationBuildContext } from "../src/generation/NarrationWriterBuilder";
import type { ActVerifyRequest } from "../src/generation/NarrationVerifierBuilder";
import type { SourcedAct, TapePointer } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";

/**
 * Q-02 / Q-03 / Q-05 (docs/curation/listening-quality-plan.md; ledger F-95):
 * narration written per ACT and verified per BEAT, with a light
 * introduction before every clip, and the listening KPIs that measure it.
 *
 * Wyatt's brief, verbatim: "The AI narration script was super clunky. It
 * seems the focus is definitely on explicitly hitting all the beats rather
 * than telling a smooth, cohesive story." / "There was inadequate, if any,
 * introduction to podcast segments." / "For 2, don't go overkill here."
 *
 * Every test names the mutation that kills it. The fixture is the deck's
 * acceptance shape: one act, four narration beats, two clips.
 */

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
const ctx: NarrationBuildContext = { userId: "founder-1" };

/* ------------------------------------------------------------ fixture */

const ITEM_A = "practical-ai--skills-over-models";
const ITEM_B = "practical-ai--a-robot-in-a-simulator";
const SEGMENT_A = `${ITEM_A}#410`;
const SEGMENT_B = `${ITEM_B}#980`;
const SHOW = "Practical AI";
const TITLE_A = "Skills over models";
const TITLE_B = "A robot in a simulator";

const ANCHOR_A = "so the first thing to understand is";
const ANCHOR_B = "when we put the robot in the simulator";

/** Ninety seconds of run-up, then the clip from its anchor on. */
const WINDOW_A =
  "Before the break we were talking about hiring, and how long it takes to find people who can maintain a pipeline. " +
  `${ANCHOR_A} that the mix of skills in the organization decides the tools, and the model choice comes last, ` +
  "because a team that cannot keep a pipeline running will not keep any model running for long. " +
  "We saw that at three companies in a row, and each time the fix was a hire, not a model.";

const WINDOW_B_PLAIN =
  "That was the part of the conversation about tooling, which we will come back to. " +
  `${ANCHOR_B} the first thing that broke was the physics, not the policy, ` +
  "and it took a week of watching replays to see that the wheels were sliding on a floor that did not exist. " +
  "Once the floor was fixed the policy started to learn again.";

/** The same clip, but the host's own introduction sits in its opening. */
const WINDOW_B_HOSTED =
  "That was the part of the conversation about tooling, which we will come back to. " +
  `${ANCHOR_B} — and my guest today is Chris Benson, who runs the robotics group — ` +
  "the first thing that broke was the physics, not the policy, and it took a week of watching replays to see it.";

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

/** Four narration beats, two clips. Beat ids run over EVERY beat of the
 * act in play order, clips included (the verifier's note says "beat b3" of
 * the act): s0 {b0, b1} → c0 (= b2); s1 {b3} → c1 (= b4); s2 {b5}. */
function fourBeatsTwoClips(): SourcedAct {
  return {
    title: "Act 1: Skills decide the tools",
    slots: [
      { title: "Opening", beats: [narration(CLAIMS.b0), narration(CLAIMS.b1), tape("A guest explains why skills decide the tools.", TAPE_A)] },
      { title: "The turn", beats: [narration(CLAIMS.b2), tape("The robot in the simulator.", TAPE_B), narration(CLAIMS.b3)] }
    ]
  };
}

/** A gatherer in the shape of the real one: a tape beat's pack holds its
 * own window with the show and episode as tape context; a narration
 * beat's pack holds the print document and the windows on either side. */
function gatherer(windows: Record<string, string> = { [SEGMENT_A]: WINDOW_A, [SEGMENT_B]: WINDOW_B_PLAIN }): EvidenceGatherer & { seen: EvidenceBeat[] } {
  const titles: Record<string, { show: string; title: string }> = { [ITEM_A]: { show: SHOW, title: TITLE_A }, [ITEM_B]: { show: SHOW, title: TITLE_B } };
  const windowDoc = (p: TapePointer): EvidenceDoc | undefined => {
    const text = windows[p.segmentId];
    if (text === undefined) return undefined;
    const t = titles[p.itemId]!;
    return { docId: tapeDocIdFor(p.segmentId), kind: "tape", title: `${t.show} — ${t.title}`, text };
  };
  const g = {
    seen: [] as EvidenceBeat[],
    async gather(beat: EvidenceBeat): Promise<EvidencePack> {
      g.seen.push(beat);
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
  return g;
}

/** The stub builders, counted, with a hook to mutate what the writer says. */
function builders(mutate?: (reply: ActWriteResult, request: ActWriteRequest, round: number) => ActWriteResult) {
  const writer = new StubNarrationWriterBuilder();
  const verifier = new StubNarrationVerifierBuilder();
  const calls = { write: 0, verify: 0, merged: 0, verifySlot: 0 };
  const requests: ActWriteRequest[] = [];
  const realWrite = writer.writeAct.bind(writer);
  writer.writeAct = async (request, buildCtx) => {
    calls.write++;
    requests.push(request);
    const reply = await realWrite(request, buildCtx);
    return mutate ? mutate(reply, request, calls.write) : reply;
  };
  const realMerged = writer.selectAndWrite.bind(writer);
  writer.selectAndWrite = async (request, buildCtx) => {
    calls.merged++;
    return realMerged(request, buildCtx);
  };
  const realVerify = verifier.verifyAct.bind(verifier);
  verifier.verifyAct = async (request, buildCtx) => {
    calls.verify++;
    return realVerify(request, buildCtx);
  };
  const realSlot = verifier.verifySlot.bind(verifier);
  verifier.verifySlot = async (request, buildCtx) => {
    calls.verifySlot++;
    return realSlot(request, buildCtx);
  };
  return { writer, verifier, calls, requests };
}

const pagesInOrder = (act: WrittenAct): NarratedBeat[] => allWrittenNarration([act]);
const narrationBeatsOf = (act: WrittenAct) => act.slots.flatMap((s) => s.beats).filter((b) => b.sourcing === "narration");

/* ---------------------------------------------------- the act contract */

describe("Q-03 — narration is written per act and verified per beat", () => {
  it("a fixture act with four beats and two clips yields prose the verifier passes on all four, in two calls (≤ 3), one page per seam", async () => {
    /* MUTATION THAT KILLS THIS: call the writer per slot (`writeSlot`) when
       the builders offer the act contract — the call count rises to one per
       slot and the page count to one per beat. Or: place the seam's page on
       EVERY beat of the seam rather than the first — `pages` reads 4 and
       `carriedBy` is never set. */
    const { writer, verifier, calls } = builders();
    const [act] = await writeNarration([fourBeatsTwoClips()], { writer, verifier, evidence: gatherer() }, voice, ctx);

    expect(calls).toEqual({ write: 1, verify: 1, merged: 0, verifySlot: 0 });
    expect(calls.write + calls.verify).toBeLessThanOrEqual(3);

    const beats = narrationBeatsOf(act!);
    expect(beats).toHaveLength(4);
    /* Every beat's claim was confirmed on round 1. */
    expect(beats.map((b) => b.sourcing === "narration" && b.verifiedAtAttempt)).toEqual([1, 1, 1, 1]);

    /* Three seams, three pages: b0 holds s0's (b1 points at it), b3 holds
       s1's, b5 holds s2's. */
    const pages = pagesInOrder(act!);
    expect(pages).toHaveLength(3);
    expect(pages.every((p) => p.verified && p.purposeAccomplished === true)).toBe(true);
    const [b0, b1, b2, b3] = beats as Array<Extract<(typeof beats)[number], { sourcing: "narration" }>>;
    expect(b0!.narration).toBeDefined();
    expect(b1!.narration).toBeUndefined();
    expect(b1!.carriedBy).toEqual({ slot: 0, beat: 0 });
    expect(b2!.narration).toBeDefined();
    expect(b3!.narration).toBeDefined();
    /* Every beat came out where it went in. */
    expect(act!.slots.map((s) => s.beats.length)).toEqual([3, 3]);
  });

  it("a mutation dropping a beat from the prose is red: the verifier names the beat, the retry edits the act, and after three rounds the seam is kept unverified for the gate", async () => {
    /* THE MUTATION, applied deliberately: the writer's seam s1 says nothing
       about beat b3 (its sentence is swapped for a filler of the same
       length and its claim dropped, so every mechanical rule still holds
       and only the verifier can catch it). A writer that quietly did this
       in production must come out red here: the page is unverified,
       `unverifiedPages` counts it, and the note names b3. If this test ever
       passes with the mutation applied, the per-beat question has stopped
       being asked. */
    const filler = "That thread runs further than most listeners expect, and the people closest to it saw it very differently at the time.";
    const { writer, verifier, calls, requests } = builders((reply) => ({
      seams: reply.seams.map((s) => {
        if (s.seamId !== "s1") return s;
        const claims = s.claims.filter((c) => c.claimText !== CLAIMS.b2);
        return { ...s, script: s.script.replace(/[^.]*investigators traced[^.]*\./i, filler), claims, usedClaims: claims.map((_, i) => i) };
      })
    }));
    const [act] = await writeNarration([fourBeatsTwoClips()], { writer, verifier, evidence: gatherer() }, voice, ctx);

    expect(calls.write).toBe(3);
    expect(calls.verify).toBe(3);
    /* The retry is an EDIT of the act: every seam's previous script travels
       with the request, and the note names the missing beat and its claim. */
    expect(requests[1]!.seams.every((s) => typeof s.previousScript === "string")).toBe(true);
    expect(requests[1]!.retryNote).toMatch(/does not carry beat b3/);
    expect(requests[1]!.retryNote).toContain("Investigators traced");

    const beats = narrationBeatsOf(act!) as Array<{ sourcing: "narration"; verifiedAtAttempt?: number; narration?: NarratedBeat }>;
    expect(beats.map((b) => b.verifiedAtAttempt)).toEqual([1, 1, undefined, 1]);
    const s1 = beats[2]!.narration!;
    expect(s1.verified).toBe(false);
    expect(s1.verifierNotes).toMatch(/b3/);
    expect(s1.attempts).toHaveLength(3);
    const unverified = computeUnverifiedPages([act!]);
    expect(unverified.count).toBe(1);
    expect(unverified.pages[0]!.claim).toBe(CLAIMS.b2);
    /* The other seams are untouched by the failure: verified, first round. */
    expect(beats[0]!.narration!.verified).toBe(true);
    expect(beats[3]!.narration!.verified).toBe(true);
  });

  it("a seam page may cite any clip window of the act whatever its mode (F-82, act-wide), and the seam's band is the sum of the beats it carries", async () => {
    /* MUTATION THAT KILLS THIS: drop `tapeCitable` from the validator call
       in `draftSeam` — a Patch seam citing a window is refused
       `tape-source-on-content-page` three times. Or: hold the seam to
       `MODE_CHAR_BANDS[mode]` instead of `seamBand` — the s0 page (two
       Patch beats and an Intro) is refused for its length. */
    const { writer, verifier } = builders();
    const [act] = await writeNarration([fourBeatsTwoClips()], { writer, verifier, evidence: gatherer() }, voice, ctx);
    const s0 = pagesInOrder(act!)[0]!;
    expect(s0.mode).toBe("Patch");
    expect(s0.sources.some((s) => "kind" in s && s.kind === "tape" && s.segmentId === SEGMENT_A)).toBe(true);
    expect(validateNarratedBeat(s0, { charBand: seamBand(planActSeams(fourBeatsTwoClips())[0]!), tapeCitable: true }).valid).toBe(true);
    expect(validateNarratedBeat(s0, { tapeCitable: false }).issues.map((i) => i.code)).toContain("tape-source-on-content-page");
  });

  it("the act path honours a per-slot resume only when every slot is banked; a half-banked act is written whole (legacy checkpoint keys stay readable)", async () => {
    /* MUTATION THAT KILLS THIS: honour a partial resume (assemble the act
       from one banked slot and one fresh) — seams span slots, so the fresh
       half is written against a page-shaped other half; the call count
       below reads 1 for the half-banked act too. */
    const { writer, verifier, calls } = builders();
    const [first] = await writeNarration([fourBeatsTwoClips()], { writer, verifier, evidence: gatherer() }, voice, ctx);
    const banked = first!.slots;

    const [resumed] = await writeNarration([fourBeatsTwoClips()], { writer, verifier, evidence: gatherer(), resume: (_a, i) => banked[i] }, voice, ctx);
    expect(calls.write).toBe(1);
    expect(resumed).toEqual(first);

    const [rebuilt] = await writeNarration([fourBeatsTwoClips()], { writer, verifier, evidence: gatherer(), resume: (_a, i) => (i === 0 ? banked[0] : undefined) }, voice, ctx);
    expect(calls.write).toBe(2);
    expect(pagesInOrder(rebuilt!)).toHaveLength(3);
  });

  it("writeActNarration refuses a writer or verifier without the act contract, and writeNarration falls back to the per-slot path for one", async () => {
    /* MUTATION THAT KILLS THIS: take the act path whenever the WRITER offers
       it, ignoring the verifier — a scripted verifier without `verifyAct` is
       then called into nothing. */
    const { writer } = builders();
    const legacyVerifier = { providerName: "stub", verifySlot: (r: Parameters<StubNarrationVerifierBuilder["verifySlot"]>[0], c: NarrationBuildContext) => new StubNarrationVerifierBuilder().verifySlot(r, c) };
    await expect(writeActNarration(fourBeatsTwoClips(), { writer, verifier: legacyVerifier, evidence: gatherer() }, voice, ctx)).rejects.toThrow(/per-act contract/);
    const [act] = await writeNarration([fourBeatsTwoClips()], { writer, verifier: legacyVerifier, evidence: gatherer() }, voice, ctx);
    /* The per-page path: one page per narration beat plus Frames — more than one per seam. */
    expect(pagesInOrder(act!).length).toBeGreaterThan(3);
  });
});

/* ------------------------------------------------------------- Q-02 */

describe("Q-02 — every clip gets a light introduction", () => {
  it("an Intro is present before each clip, naming the show the segment source carries, and is written on the seam's page (no extra item)", async () => {
    /* MUTATION THAT KILLS THIS: decide every clip `none` (drop the
       `full` branch of `decideIntro`) — the stub then writes no
       introduction and neither page names the show. */
    const { writer, verifier } = builders();
    const [act] = await writeNarration([fourBeatsTwoClips()], { writer, verifier, evidence: gatherer() }, voice, ctx);
    const items = stitchAct(act!, "act-1").items;
    const before = (segmentId: string) => {
      const at = items.findIndex((i) => i.kind === "tape" && i.segmentId === segmentId);
      const previous = items[at - 1];
      return previous && previous.kind === "narration" ? previous.script : "";
    };
    expect(introNamesSource(before(SEGMENT_A), { show: SHOW, title: TITLE_A })).toBe(true);
    expect(introNamesSource(before(SEGMENT_B), { show: SHOW, title: TITLE_B })).toBe(true);
    expect(items.filter((i) => i.kind === "narration")).toHaveLength(3);
  });

  it("there is no Intro when the clip opens with the host's own introduction, and one clause at most when the previous clip was the same episode", async () => {
    /* MUTATION THAT KILLS THIS: delete the `my guest today is` pattern from
       `HOST_INTRO_PATTERNS` (clip B is then introduced twice — by the
       narrator and by the host), or compare `itemId`s by segment instead of
       episode (the same-episode follow-on then gets a full introduction). */
    const hosted = gatherer({ [SEGMENT_A]: WINDOW_A, [SEGMENT_B]: WINDOW_B_HOSTED });
    const { writer, verifier, requests } = builders();
    const [act] = await writeNarration([fourBeatsTwoClips()], { writer, verifier, evidence: hosted }, voice, ctx);
    expect(requests[0]!.clips.map((c) => [c.clipId, c.intro])).toEqual([
      ["c0", "full"],
      ["c1", "none"]
    ]);
    const s1 = pagesInOrder(act!)[1]!;
    expect(introNamesSource(s1.script, { show: SHOW, title: TITLE_B })).toBe(false);
    expect(s1.verified).toBe(true);

    /* Same episode, back to back: a beatless seam whose Intro is light — a
       clause on the clip as `connectiveNarration`, mode Intro. */
    const followOn: SourcedAct = { title: "Act", slots: [{ title: "Slot", beats: [tape("First cut.", TAPE_A), tape("Second cut of the same episode.", { ...TAPE_A, segmentId: `${ITEM_A}#900`, startSec: 900, endSec: 960 })] }] };
    const same = builders();
    const [written] = await writeNarration([followOn], { writer: same.writer, verifier: same.verifier, evidence: gatherer({ [SEGMENT_A]: WINDOW_A, [`${ITEM_A}#900`]: WINDOW_A }) }, voice, ctx);
    expect(same.requests[0]!.clips.map((c) => c.intro)).toEqual(["full", "light"]);
    const second = written!.slots[0]!.beats[1]!;
    expect(second.sourcing === "tape" && second.connectiveNarration?.mode).toBe("Intro");
    expect(second.sourcing === "tape" && second.connectiveNarration!.script.length).toBeLessThanOrEqual(MODE_CHAR_BANDS.Intro[1]);
  });

  it("an Intro that repeats the clip's first sentence is refused in code, the writer is told, and the report's introRestates reads 0 once it is fixed", async () => {
    /* THE MUTATION, applied on round 1 only: the writer's s0 opens with the
       clip's own first sentence. The gate refuses the act before any
       verifier call (`refused in code`), the note quotes the shared run, and
       round 2 — unmutated — passes. A gate that let it through would show
       up as `introRestates` 1 in the report, which the last assertion pins
       by feeding the mutated page to the metric directly. */
    const openingA = clipOpening(WINDOW_A, ANCHOR_A);
    const firstSentence = openingA.split(/(?<=[.!?])\s+/)[0]!;
    const { writer, verifier, calls, requests } = builders((reply, _request, round) =>
      round === 1 ? { seams: reply.seams.map((s) => (s.seamId === "s0" ? { ...s, script: `${firstSentence} ${s.script}` } : s)) } : reply
    );
    const [act] = await writeNarration([fourBeatsTwoClips()], { writer, verifier, evidence: gatherer() }, voice, ctx);
    expect(calls.write).toBe(2);
    expect(calls.verify).toBe(1);
    expect(requests[1]!.retryNote).toMatch(/repeats the clip's own first sentences/);
    const s0 = pagesInOrder(act!)[0]!;
    expect(s0.verified).toBe(true);
    expect(s0.attempts?.[0]).toMatchObject({ attempt: 1, rejected: true });
    expect(s0.attempts?.[0]?.rejectionNote).toMatch(/Q-02/);
    expect(computeIntroRestates([act!])).toBe(0);

    /* The metric itself, on a page that DOES restate: 1. */
    const restating: WrittenAct = {
      ...act!,
      slots: act!.slots.map((slot, si) =>
        si === 0
          ? { ...slot, beats: slot.beats.map((b) => (b.sourcing === "narration" && b.narration ? { ...b, narration: { ...b.narration, script: `${firstSentence} ${b.narration.script}` } } : b)) }
          : slot
      )
    };
    expect(computeIntroRestates([restating])).toBe(1);
  });

  it("a full Intro that names neither the show nor anyone the episode title names is refused, unless the source row names nothing at all", async () => {
    /* MUTATION THAT KILLS THIS: drop the `introNamesSource` check from
       `draftSeam` — the nameless introduction below passes round 1. Or:
       fail the check when the row is empty — the second act is refused three
       times for a name it could never say. */
    const { writer, verifier, calls, requests } = builders((reply, _request, round) =>
      round === 1 ? { seams: reply.seams.map((s) => (s.seamId === "s0" ? { ...s, script: s.script.replace(/Practical AI/g, "the show").replace(/Skills over models/g, "an episode") } : s)) } : reply
    );
    await writeNarration([fourBeatsTwoClips()], { writer, verifier, evidence: gatherer() }, voice, ctx);
    expect(calls.write).toBe(2);
    expect(requests[1]!.retryNote).toMatch(/names neither the show/);

    /* No window, no tape context, no minted row: nothing names the clip
       (the dry-run stub's tape, or a tier-2 item whose row was not minted). */
    const nameless = gatherer();
    const realGather = nameless.gather.bind(nameless);
    nameless.gather = async (beat, buildCtx) => {
      const pack = await realGather(beat, buildCtx);
      const { tape: _tape, ...rest } = pack;
      return { ...rest, docs: pack.docs.filter((d) => d.kind !== "tape") };
    };
    const quiet = builders();
    const [act] = await writeNarration([fourBeatsTwoClips()], { writer: quiet.writer, verifier: quiet.verifier, evidence: nameless }, voice, ctx);
    expect(quiet.calls.write).toBe(1);
    expect(pagesInOrder(act!).every((p) => p.verified)).toBe(true);
  });
});

/* ------------------------------------------------------------- Q-05 */

describe("Q-05 — the listening KPIs are computed from the candidate", () => {
  it("narrationPagesPerSeam, narrationShare, tapeShare, introRestates, narrationCallsPerAct and a beat-level firstAttemptPassRate ride on meta.veracity", async () => {
    /* MUTATION THAT KILLS THIS: compute `firstAttemptPassRate` from pages'
       `attempts` on the act path (the s0 page carries two beats — one page,
       not two beats), or count seams from written pages instead of
       `planActSeams` (a dropped intro-only seam then reads 1.0 instead of
       < 1). */
    const { writer, verifier, calls } = builders();
    const sourced = fourBeatsTwoClips();
    const [act] = await writeNarration([sourced], { writer, verifier, evidence: gatherer() }, voice, ctx);
    const veracity = buildVeracityMetrics({
      sourcedActs: [sourced],
      writtenActs: [act!],
      topic: "computing/ai",
      writerCalls: calls.write,
      verifierCalls: calls.verify,
      retryRounds: 0,
      pipelineTokens: 0,
      stageTimings: [],
      tapeRelevanceRows: []
    });
    expect(veracity.narrationPagesPerSeam).toBe(1);
    expect(veracity.narrationCallsPerAct).toBe(2);
    expect(veracity.introRestates).toBe(0);
    expect(veracity.firstAttemptPassRate).toBe(1);
    const shares = computeListeningShares([sourced], [act!]);
    expect(shares.tapeSec).toBe(240);
    expect(shares.narrationSec).toBeGreaterThan(0);
    expect(veracity.tapeShare).toBeCloseTo(240 / (240 + shares.narrationSec), 6);
    expect(veracity.narrationShare).toBeCloseTo(shares.narrationSec / (240 + shares.narrationSec), 6);
    expect(veracity.tapeShare! + veracity.narrationShare!).toBeCloseTo(1, 6);
    expect(computePagesDropped([sourced], [act!])).toBe(0);
    expect(computeNarrationCallsPerAct([sourced, sourced], 3, 3)).toBe(3);
    expect(computeNarrationPagesPerSeam([], [])).toBeNull();

    /* Beat-level: a beat confirmed on round 2 counts against the rate even
       though its page carries a single attempt record. */
    const slow: WrittenAct = { ...act!, slots: act!.slots.map((s, i) => (i === 1 ? { ...s, beats: s.beats.map((b) => (b.sourcing === "narration" && b.claim === CLAIMS.b2 ? { ...b, verifiedAtAttempt: 2 } : b)) } : s)) };
    expect(computeFirstAttemptPassRate([slow])).toBe(0.75);
  });
});

/* --------------------------------------------------- the pure rules */

describe("actSeams — the plan and the Intro rules", () => {
  it("plans one seam per stretch of narration and one beatless seam per clip-after-clip, in play order across slots", () => {
    /* MUTATION THAT KILLS THIS: start a new seam at every slot boundary —
       s1 then holds nothing and b2 opens a fourth seam. */
    const seams = planActSeams(fourBeatsTwoClips());
    expect(seams.map((s) => [s.seamId, s.beats.map((b) => b.beatId), s.follows?.clipId ?? null, s.introduces?.clipId ?? null])).toEqual([
      ["s0", ["b0", "b1"], null, "c0"],
      ["s1", ["b3"], "c0", "c1"],
      ["s2", ["b5"], "c1", null]
    ]);
    const backToBack: SourcedAct = { title: "A", slots: [{ title: "S", beats: [tape("x", TAPE_A), tape("y", TAPE_B)] }] };
    expect(planActSeams(backToBack).map((s) => [s.seamId, s.beats.length, s.introduces?.clipId])).toEqual([
      ["s0", 0, "c0"],
      ["s1", 0, "c1"]
    ]);
    expect(seams.map((s) => seamMode(s))).toEqual(["Patch", "Patch", "Patch"]);
    expect(seamMode({ beats: [] })).toBe("Intro");
    expect(seamMode({ beats: [{ ...seams[0]!.beats[0]!, mode: "Carry" }] })).toBe("Carry");
  });

  it("a seam's band is the largest floor among its beats and the sum of their ceilings plus an Intro, capped at the 150 s soft max", () => {
    /* MUTATION THAT KILLS THIS: sum the floors (three Patches then demand
       1,020 characters of a stretch that needs one Patch's worth), or drop
       the cap (two Carries license 3,740 characters, past the checker's
       soft max). */
    const seams = planActSeams(fourBeatsTwoClips());
    expect(seamBand(seams[0]!)).toEqual([340, 765 * 2 + 260]);
    expect(seamBand(seams[2]!)).toEqual([340, 765]);
    expect(seamBand({ beats: [], introduces: seams[0]!.introduces })).toEqual(MODE_CHAR_BANDS.Intro);
    const carries = { beats: [{ ...seams[0]!.beats[0]!, mode: "Carry" as const }, { ...seams[0]!.beats[1]!, mode: "Carry" as const }] };
    expect(seamBand(carries)).toEqual([765, SEAM_MAX_CHARS]);
    expect(SEAM_MAX_CHARS).toBe(2550);
  });

  it("clipOpening returns the clip from its start anchor on, not the window's run-up, and nothing when the anchor is absent", () => {
    /* MUTATION THAT KILLS THIS: return the window's first N words — the
       opening then begins with the run-up ("Before the break…"). */
    const opening = clipOpening(WINDOW_A, ANCHOR_A);
    expect(opening.startsWith("so the first thing to understand is")).toBe(true);
    expect(opening).not.toContain("Before the break");
    expect(clipOpening(WINDOW_A, ANCHOR_A, 3)).toBe("so the first");
    expect(clipOpening(WINDOW_A, "words that are not spoken here")).toBe("");
    expect(clipOpening("", ANCHOR_A)).toBe("");
    expect(CLIP_OPENING_WORDS).toBe(150);
  });

  it("hostIntroducesGuest matches the host's own introduction on the canonical opening and nothing else", () => {
    /* MUTATION THAT KILLS THIS: test the raw text instead of the canonical
       form — "I'm here with" no longer matches `im here with`. */
    expect(hostIntroducesGuest("So today I'm here with Chris Benson, who runs the robotics group.")).toBe(true);
    expect(hostIntroducesGuest("my guest today is Jane Doe")).toBe(true);
    expect(hostIntroducesGuest("Welcome back to the show, everybody.")).toBe(true);
    expect(hostIntroducesGuest("Thanks so much for having me.")).toBe(true);
    expect(hostIntroducesGuest("the first thing that broke was the physics, not the policy")).toBe(false);
    expect(hostIntroducesGuest("")).toBe(false);
    expect(HOST_INTRO_PATTERNS.length).toBeGreaterThanOrEqual(10);
  });

  it("decideIntro: none when the host introduces, light for the same episode, full otherwise", () => {
    /* MUTATION THAT KILLS THIS: check the same-episode rule before the host
       rule — a hosted follow-on reads `light` instead of `none`. */
    expect(decideIntro({ itemId: ITEM_B }, { itemId: ITEM_A }, WINDOW_B_PLAIN)).toBe("full");
    expect(decideIntro({ itemId: ITEM_B }, undefined, WINDOW_B_PLAIN)).toBe("full");
    expect(decideIntro({ itemId: ITEM_A }, { itemId: ITEM_A }, WINDOW_A)).toBe("light");
    expect(decideIntro({ itemId: ITEM_A }, { itemId: ITEM_A }, clipOpening(WINDOW_B_HOSTED, ANCHOR_B))).toBe("none");
  });

  it("introNamesSource accepts the show as a phrase or a name from the episode title, and refuses title-case filler", () => {
    /* MUTATION THAT KILLS THIS: accept any capitalised title token — "Over"
       or "Episode" then names a guest. */
    expect(introNamesSource("Next, from Practical AI, a conversation about hiring.", { show: SHOW, title: TITLE_A })).toBe(true);
    expect(introNamesSource("Here is Chris Benson on the robot.", { show: SHOW, title: "Ep. 12: Chris Benson on simulators" })).toBe(true);
    expect(introNamesSource("An episode about robots.", { show: SHOW, title: "Episode 9: Did Cooking Make Us Human?" })).toBe(false);
    expect(introNamesSource("Listen for what breaks first.", { show: SHOW, title: TITLE_B })).toBe(false);
    expect(introNamesSource("", { show: SHOW, title: TITLE_B })).toBe(false);
  });

  it("introRestatesClip fires on a six-word run shared with the clip's first sixty words, and quotes the run", () => {
    /* MUTATION THAT KILLS THIS: compare whole sentences only — a page that
       lifts half a sentence passes. Or: search the whole window instead of
       its first sentences — a page that restates the clip's END is refused
       for it, which is the "may restate once after the clip" case. */
    const opening = clipOpening(WINDOW_A, ANCHOR_A);
    const lifted = "The guest says that the mix of skills in the organization decides the tools, then moves on.";
    expect(introRestatesClip(lifted, opening)).toEqual({ restates: true, run: "that the mix of skills in" });
    expect(introRestatesClip("Listen for what a team can keep running, and for what it cannot.", opening).restates).toBe(false);
    expect(introRestatesClip(lifted, "")).toEqual({ restates: false });
    const tail = "each time the fix was a hire, not a model";
    const longClip = `${"and so on ".repeat(25)}${tail}, which is where we left it.`;
    expect(introRestatesClip(`As the guest put it, ${tail}.`, longClip).restates).toBe(false);
    expect(introRestatesClip(`As the guest put it, ${tail}.`, `${tail}, which is where we started.`).restates).toBe(true);
    expect(INTRO_RESTATE_RUN_WORDS).toBe(6);
    expect(CLIP_FIRST_SENTENCES_WORDS).toBe(60);
  });

  it("Intro is a narration mode that may cite tape, with a 30–260 character band, mirrored in check-narration.mjs", async () => {
    /* MUTATION THAT KILLS THIS: add `intro` to one table and not the other
       — the two disagree about a seventh mode. */
    expect(MODE_CHAR_BANDS.Intro).toEqual([30, 260]);
    expect(TAPE_SOURCE_MODES).toContain("Intro");
    const checker = (await import("../../tools/foray/check-narration.mjs")) as { MODE_CHAR_BANDS: Record<string, [number, number]> };
    expect(checker.MODE_CHAR_BANDS.intro).toEqual(MODE_CHAR_BANDS.Intro);
    expect(Object.keys(checker.MODE_CHAR_BANDS).sort()).toEqual(Object.keys(MODE_CHAR_BANDS).map((m) => m.toLowerCase()).sort());
  });
});

/* ------------------------------------------------- the prompts, the stubs */

describe("the per-act prompts", () => {
  const request = (): ActWriteRequest => ({
    actTitle: "Act 1",
    voice,
    seams: [
      { seamId: "s0", beats: [{ beatId: "b0", claim: CLAIMS.b0, mode: "Patch", kind: "account" }], introduces: "c0", intro: "full", mode: "Patch", band: [340, 1025] },
      { seamId: "s1", beats: [], follows: "c0", introduces: "c1", intro: "light", mode: "Intro", band: [30, 260], previousScript: "Stay with the same voice." }
    ],
    clips: [
      { clipId: "c0", segmentId: SEGMENT_A, itemId: ITEM_A, show: SHOW, title: TITLE_A, docId: tapeDocIdFor(SEGMENT_A), opening: clipOpening(WINDOW_A, ANCHOR_A), durationSec: 120, intro: "full" },
      { clipId: "c1", segmentId: SEGMENT_B, itemId: ITEM_B, show: SHOW, title: TITLE_B, opening: "", durationSec: 120, intro: "light" }
    ],
    documents: [NBS, { docId: tapeDocIdFor(SEGMENT_A), kind: "tape", title: `${SHOW} — ${TITLE_A}`, text: WINDOW_A }],
    retryNote: "Attempt 1 was rejected for: the prose does not carry beat b0."
  });

  it("the writer prompt lays the act out in play order — seams with their beats and bands, clips with their openings and introduction weights — and carries the previous scripts on a retry", () => {
    /* MUTATION THAT KILLS THIS: list the beats as a flat checklist above the
       layout (the beat then has no seam), or omit `previousScript` (the
       retry rewrites instead of editing). */
    const prompt = buildActWritePrompt(request());
    expect(prompt).toContain('one act ("Act 1")');
    expect(prompt).toContain("SEAM s0 — mode Patch, 340-1025 characters — introduces CLIP c0 (introduction: full)");
    expect(prompt).toContain(`  carries beat b0: ${CLAIMS.b0}`);
    expect(prompt).toContain(`CLIP c0 — "${TITLE_A}" on ${SHOW}, 120 s of tape (document ${tapeDocIdFor(SEGMENT_A)})`);
    expect(prompt).toContain('  it opens: "so the first thing to understand is');
    expect(prompt).toContain("SEAM s1 — mode Intro, 30-260 characters — follows CLIP c0, introduces CLIP c1 (introduction: light)");
    expect(prompt).toContain("  carries no beat — the introduction only, or nothing");
    expect(prompt).toContain('  previous script: "Stay with the same voice."');
    expect(prompt).toContain("its opening is not held");
    expect(prompt).toContain("REJECTIONS SO FAR: Attempt 1 was rejected for: the prose does not carry beat b0.");
    expect(prompt).toContain("EDIT the act's prose");
    expect(prompt).toContain("Do not repeat the clip's first sentences");
    expect(prompt).toContain("TRANSCRIPT WINDOW of a clip");
    expect(prompt.indexOf("SEAM s0")).toBeLessThan(prompt.indexOf("CLIP c0"));
    expect(prompt.indexOf("CLIP c0")).toBeLessThan(prompt.indexOf("SEAM s1"));
    expect(prompt).toContain('{"seams": [{"seamId": string, "script": string, "claims": [');
  });

  it("the verifier prompt puts the beats first as the checklist, asks `carried` per beat and support/contested per seam, prints every clip's window, and exempts the introduction from the support question", () => {
    /* MUTATION THAT KILLS THIS: ask `purposeAccomplished` per seam instead
       of `carried` per beat — a beat carried in another seam is then refused
       with its seam. */
    const req: ActVerifyRequest = {
      actTitle: "Act 1",
      voice,
      beats: [{ beatId: "b0", claim: CLAIMS.b0, mode: "Patch", kind: "account" }],
      seams: [{ seamId: "s0", mode: "Patch", script: "The hangers carried double.", sources: [{ kind: "tape", segmentId: SEGMENT_A, claimText: "who speaks", publication: `${SHOW} — ${TITLE_A}`, contested: false }], carries: ["b0"], introduces: "c0", intro: "full" }],
      clips: [{ clipId: "c0", segmentId: SEGMENT_A, itemId: ITEM_A, show: SHOW, title: TITLE_A, docId: tapeDocIdFor(SEGMENT_A), opening: "", durationSec: 120, intro: "full", windowText: WINDOW_A }],
      documents: [NBS]
    };
    const prompt = buildActVerifyPrompt(req);
    expect(prompt).toContain("THE CHECKLIST — every beat the act's narration must carry:");
    expect(prompt).toContain(`  b0: ${CLAIMS.b0}`);
    expect(prompt.indexOf("THE CHECKLIST")).toBeLessThan(prompt.indexOf("SEAM s0"));
    expect(prompt).toContain("SEAM s0 — mode Patch, positioned beats b0 — introduces CLIP c0 (introduction: full)");
    expect(prompt).toContain(`Source 1 [TAPE ${SEGMENT_A}]`);
    expect(prompt).toContain(`  Transcript window:\n${WINDOW_A}`);
    expect(prompt).toContain("carried — does the act's narration (any seam");
    expect(prompt).toContain("EXEMPT from this question: the sentences that introduce a clip");
    expect(prompt).toContain('{"beats": [{"beatId": string, "carried": boolean');
    expect(prompt).toContain(NBS.text);
  });

  it("the stub verifier answers per beat with a note naming the seam the beat was positioned in", () => {
    /* MUTATION THAT KILLS THIS: mark every beat carried. */
    const verdicts = actVerdictFor({
      actTitle: "A",
      voice,
      beats: [
        { beatId: "b0", claim: "The hangers carried double the load.", mode: "Patch", kind: "account" },
        { beatId: "b1", claim: "Investigators traced the fabricator's drawing.", mode: "Patch", kind: "account" }
      ],
      seams: [{ seamId: "s0", mode: "Patch", script: "The hangers carried double the load the design assumed.", sources: [{ claimText: "c", quote: "q", publication: "P", contested: false }], carries: ["b0", "b1"] }],
      clips: [],
      documents: []
    });
    expect(verdicts.beats).toEqual([
      { beatId: "b0", carried: true },
      { beatId: "b1", carried: false, notes: expect.stringContaining("positioned in seam s0") }
    ]);
    expect(verdicts.seams[0]).toMatchObject({ seamId: "s0", claimsSupported: true, contestedHandled: true });
  });

  it("the stub writer's seam names the show and episode, cites the clip's window for the introduction when it is held, and pads to the seam's band", () => {
    /* MUTATION THAT KILLS THIS: write the introduction without a source when
       the window is held — a declarative sentence with no source is refused
       by `validateNarratedBeat`. */
    const clips = new Map(request().clips.map((c) => [c.clipId, c]));
    const seam = stubSeam(request().seams[0]!, clips, request().documents, "conversational");
    expect(seam.script).toContain(`from ${SHOW}, "${TITLE_A}"`);
    expect(seam.claims[0]).toMatchObject({ docId: tapeDocIdFor(SEGMENT_A), quote: "" });
    expect(seam.script.length).toBeGreaterThanOrEqual(340);
    expect(seam.script.length).toBeLessThanOrEqual(1025);
    const hostedClips = new Map(request().clips.map((c) => [c.clipId, c.clipId === "c1" ? { ...c, intro: "none" as const } : c]));
    const empty = stubSeam({ ...request().seams[1]!, intro: "none" }, hostedClips, request().documents, "conversational");
    expect(empty.script).toBe("");
  });

  it("actDocuments dedupes act-wide and strips the per-page position; titlesForClip reads the pack, then the minted rows, then the window's title", () => {
    /* MUTATION THAT KILLS THIS: keep `tapePosition` on the act's documents
       (one window is "previous" for one page and "next" for another — the
       first wins and the layout lies). */
    const w: EvidenceDoc = { docId: tapeDocIdFor(SEGMENT_A), kind: "tape", title: `${SHOW} — ${TITLE_A}`, text: WINDOW_A, tapePosition: "previous" };
    const docs = actDocuments([
      { purpose: "a", beatKind: "account", docs: [w, NBS] },
      { purpose: "b", beatKind: "account", docs: [{ ...w, tapePosition: "next" }] }
    ]);
    expect(docs.map((d) => d.docId)).toEqual([w.docId, NBS.docId]);
    expect("tapePosition" in docs[0]!).toBe(false);

    const clip = planActSeams(fourBeatsTwoClips())[0]!.introduces!;
    expect(titlesForClip(clip, { purpose: "p", beatKind: "account", docs: [], tape: { itemId: ITEM_A, showTitle: "S", episodeTitle: "E", startSec: 0, endSec: 1 } }, undefined, undefined)).toEqual({ show: "S", title: "E" });
    expect(titlesForClip(clip, undefined, undefined, [{ id: ITEM_A, show: "Minted", title: "Row" }])).toEqual({ show: "Minted", title: "Row" });
    expect(titlesForClip(clip, undefined, w, undefined)).toEqual({ show: SHOW, title: TITLE_A });
    expect(titlesForClip(clip, undefined, undefined, undefined)).toEqual({ show: "", title: "" });
  });

  it("stitchAct emits one narration item per seam — a beat carried by another's page emits nothing and stays present in coverage", async () => {
    /* MUTATION THAT KILLS THIS: emit an item for a `carriedBy` beat (there is
       no script — the stitcher throws or emits an empty item), or skip its
       coverage entry (`validateActCoverage` then reports a lost beat). */
    const { writer, verifier } = builders();
    const [act] = await writeNarration([fourBeatsTwoClips()], { writer, verifier, evidence: gatherer() }, voice, ctx);
    const stitched = stitchAct(act!, "act-1");
    expect(stitched.items.map((i) => i.kind)).toEqual(["narration", "tape", "narration", "tape", "narration"]);
    expect(stitched.coverage.entries.map((e) => e.status)).toEqual(["present", "present", "present", "present", "present", "present"]);
    expect(act!.slots.flatMap((s) => s.beats).map((b) => pageOfWrittenBeat(b) !== undefined)).toEqual([true, false, false, true, false, true]);
  });
});
