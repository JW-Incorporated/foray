import { describe, it, expect } from "vitest";
import {
  DEFAULT_ACT_ROUND_POLICY,
  NARRATION_PAGE_ATTEMPTS,
  TIMED_ACT_ROUND_POLICY,
  allWrittenNarration,
  roundPolicyFor,
  writeNarration,
  type ActRoundPolicy,
  type NarrationWriteStats,
  type WrittenAct
} from "../src/generation/writeNarration";
import { CLASSIC_PIPELINE_FLAGS, FAST_PATH_PIPELINE_FLAGS, readPipelineFlags } from "../src/generation/pipelineFlags";
import { StubNarrationWriterBuilder } from "../src/generation/StubNarrationWriterBuilder";
import { StubNarrationVerifierBuilder } from "../src/generation/StubNarrationVerifierBuilder";
import { computeUnverifiedPages } from "../src/generation/veracityMetrics";
import { tapeDocIdFor, type NarratedBeat } from "../src/types/narration";
import type { EvidenceBeat, EvidenceDoc, EvidenceGatherer, EvidencePack } from "../src/generation/gatherEvidence";
import type { ActWriteRequest, ActWriteResult, NarrationBuildContext, NarrationWriterBuilder, SeamEditRequest } from "../src/generation/NarrationWriterBuilder";
import type { SourcedAct, TapePointer } from "../src/types/tapeSourcing";
import type { Voice } from "../src/types/spine";

/**
 * GV-80 (docs/roadmap/generation-v2.md, W4-13; GP-04, GP-02, GP-05): the
 * timed-path round policy. Under FORAY_ROUND_POLICY=timed (or the fast-path
 * umbrella) an act takes at most two rounds, and the second is a SEAM EDIT
 * (`editSeams`) holding only the failing seams, the seam on either side of
 * each, the clips they touch and the documents they cite. The default
 * policy is today's: three whole-act rounds, and `editSeams` is never
 * called.
 *
 * The fixture is a wide act (ten clips, eleven narration seams) with a long
 * print passage behind every narration beat, so a whole-act request is the
 * size a real one is in shape: the documents dominate it.
 *
 * Every test names the mutation that kills it.
 */

const voice: Voice = { style: "well-read friend", register: "conversational", sentenceRhythm: "varied", narratorPresence: "medium" };
const ctx: NarrationBuildContext = { userId: "founder-1" };

/* ------------------------------------------------------------ fixture */

const CLIPS = 10;

/** One claim per narration beat, each with content words no other claim,
 * filler, show or title shares, so the stub verifier (a shared-content-word
 * check) can only find a beat in the seam that really carries it. */
const CLAIMS = [
  "Glaciers retreated across the northern valley.",
  "Beekeepers noticed hives collapsing overnight.",
  "Lighthouse keepers logged unusual fog banks.",
  "Shipbuilders abandoned riveted hulls quickly.",
  "Cartographers redrew coastal boundaries twice.",
  "Orchard growers switched to dwarf rootstock.",
  "Telegraph operators invented shorthand codes.",
  "Bakers measured flour by weight instead.",
  "Astronomers catalogued faint comets methodically.",
  "Weavers adopted punched cards for patterns.",
  "Miners tunnelled beneath the frozen river."
] as const;

/** The seam the scripted writer fails: s3 sits between c2 and c3. */
const FAILING_SEAM = "s3";
/** Beat ids run over every beat of the act (clips included): narration
 * beat i of slot i is b(2i), so s3's beat is b6. */
const FAILING_BEAT = "b6";
const FAILING_CLAIM = CLAIMS[3];

const LETTERS = "abcdefghijklmnopqrstuvwxyz";
const itemOf = (i: number): string => `show-${LETTERS[i]}--episode-${LETTERS[i]}`;
const segmentOf = (i: number): string => `${itemOf(i)}#${100 + i}`;
const showOf = (i: number): string => `Station ${LETTERS[i]!.toUpperCase()} Radio`;
const titleOf = (i: number): string => `Episode ${LETTERS[i]!.toUpperCase()}`;
const anchorOf = (i: number): string => `and here is where the segment marked ${LETTERS[i]} begins`;

/** The extra clip `wideAct({ hostedClip: true })` adds after c6: its host
 * introduces the guest in its opening, so it needs no introduction and the
 * beatless seam before it is silent. */
const HOSTED = CLIPS;

/** Ninety seconds of run-up, then the clip from its anchor on. */
function windowText(i: number): string {
  if (i === HOSTED) {
    return (
      "That was the part of the conversation about the archive, which we will come back to. " +
      `${anchorOf(i)} — and my guest today is Dana Reyes, who keeps the archive — ` +
      "and the first thing she found was a box nobody had opened since the move."
    );
  }
  return (
    "Before the break we were talking about scheduling, and how long it takes to settle a programme. " +
    `${anchorOf(i)}, said the guest, because a plan that cannot survive a bad week will not survive a good one either, ` +
    "and the people who stay in the room are the ones who notice that first. " +
    "We kept coming back to that point all afternoon, and each time it held."
  );
}

/** A long print passage behind narration beat `i`: plain prose that echoes
 * no claim, so the stub can copy a legal span out of it. */
function printDoc(i: number): EvidenceDoc {
  const sentence =
    `Record ${LETTERS[i]} of the survey describes the ledger kept by the clerks, the order in which entries were made, ` +
    "the inks they used and the hands that wrote them, together with the margins where later readers added remarks. ";
  return { docId: `print:survey-${LETTERS[i]}`, kind: "print", title: `Survey record ${LETTERS[i]}`, text: sentence.repeat(10).trim() };
}

function pointer(i: number): TapePointer {
  return { segmentId: segmentOf(i), itemId: itemOf(i), startSec: 100 + i, endSec: 220 + i, startAnchor: anchorOf(i), endAnchor: "and each time it held", tier: 1, confidence: "high" };
}
function narration(claim: string) {
  return { sourcing: "narration" as const, claim, exploration: false, narration: { mode: "Patch" as const, reason: "t" } };
}
function tape(claim: string, tapePointer: TapePointer) {
  return { sourcing: "tape" as const, claim, exploration: false, tape: tapePointer };
}

/** Slot i: narration beat i, then clip i; the last slot is one narration
 * beat. Seams: s0 {b0} -> c0; s(i) {b(2i)} after c(i-1), into c(i); s10
 * {b20} after c9. */
function wideAct(opts: { hostedClip?: boolean } = {}): SourcedAct {
  const slots = Array.from({ length: CLIPS }, (_, i) => ({ title: `Part ${i}`, beats: [narration(CLAIMS[i]!), tape(`A guest on segment ${LETTERS[i]}.`, pointer(i))] }));
  /* A second clip straight after c6, with no narration between: the seam
     before it carries no beat. */
  if (opts.hostedClip) slots[6]!.beats.push(tape("A guest who keeps the archive.", pointer(HOSTED)));
  slots.push({ title: "Close", beats: [narration(CLAIMS[CLIPS]!)] });
  return { title: "Act 1: A wide act", slots };
}

/** A gatherer in the real one's shape: a tape beat's pack holds its own
 * window with the show and episode; a narration beat's pack holds the
 * windows on either side and its own print passage. */
function gatherer(): EvidenceGatherer {
  const index = new Map(Array.from({ length: CLIPS + 1 }, (_, i) => [segmentOf(i), i]));
  const windowDoc = (p: TapePointer): EvidenceDoc => {
    const i = index.get(p.segmentId)!;
    return { docId: tapeDocIdFor(p.segmentId), kind: "tape", title: `${showOf(i)} — ${titleOf(i)}`, text: windowText(i) };
  };
  return {
    async gather(beat: EvidenceBeat): Promise<EvidencePack> {
      const docs: EvidenceDoc[] = [];
      let tapeContext: EvidencePack["tape"];
      if (beat.tape) {
        docs.push({ ...windowDoc(beat.tape), tapePosition: "next" });
        const i = index.get(beat.tape.segmentId)!;
        tapeContext = { itemId: beat.tape.itemId, showTitle: showOf(i), episodeTitle: titleOf(i), startSec: beat.tape.startSec, endSec: beat.tape.endSec };
      }
      for (const [position, p] of [["previous", beat.adjacentTape?.previous], ["next", beat.adjacentTape?.next]] as const) {
        if (!p) continue;
        const w = windowDoc(p);
        if (docs.some((d) => d.docId === w.docId)) continue;
        docs.push({ ...w, tapePosition: position });
      }
      if (!beat.tape) docs.push(printDoc(CLAIMS.indexOf(beat.claim as (typeof CLAIMS)[number])));
      return { purpose: beat.claim, beatKind: "account", docs, ...(tapeContext ? { tape: tapeContext } : {}) };
    }
  };
}

/** The scripted failure: seam s3 comes back without its beat (the beat's
 * sentence swapped for filler and its claim dropped, so every mechanical
 * rule still holds and only the verifier catches it). */
const FILLER = "That thread runs further than most listeners expect, and the people closest to it saw it very differently at the time.";
function dropBeat(reply: ActWriteResult): ActWriteResult {
  return {
    seams: reply.seams.map((s) => {
      if (s.seamId !== FAILING_SEAM) return s;
      const claims = s.claims.filter((c) => c.claimText !== FAILING_CLAIM);
      return { ...s, script: s.script.replace(/In the voice of a[^.]*\./, FILLER), claims, usedClaims: claims.map((_, i) => i) };
    })
  };
}

/** The stub builders, counted. `failRounds` are the writer calls (1-based,
 * across writeAct and editSeams) whose reply drops s3's beat;
 * `withEditSeams: false` hides the stub's `editSeams`. */
function builders(opts: { failRounds?: number[]; withEditSeams?: boolean; mutateEdit?: (reply: ActWriteResult, request: SeamEditRequest) => ActWriteResult } = {}) {
  const stub = new StubNarrationWriterBuilder();
  const verifier = new StubNarrationVerifierBuilder();
  const calls = { writeAct: 0, editSeams: 0, verify: 0 };
  const log: Array<{ kind: "writeAct"; request: ActWriteRequest } | { kind: "editSeams"; request: SeamEditRequest }> = [];
  const failing = (n: number): boolean => (opts.failRounds ?? []).includes(n);
  const writer: NarrationWriterBuilder = {
    providerName: "scripted",
    writeAct: async (request, buildCtx) => {
      calls.writeAct++;
      log.push({ kind: "writeAct", request });
      const reply = await stub.writeAct(request, buildCtx);
      return failing(log.length) ? dropBeat(reply) : reply;
    },
    ...(opts.withEditSeams === false
      ? {}
      : {
          editSeams: async (request: SeamEditRequest, buildCtx: NarrationBuildContext) => {
            calls.editSeams++;
            log.push({ kind: "editSeams", request });
            const reply = await stub.editSeams(request, buildCtx);
            const scripted = failing(log.length) ? dropBeat(reply) : reply;
            return opts.mutateEdit ? opts.mutateEdit(scripted, request) : scripted;
          }
        })
  };
  const realVerify = verifier.verifyAct.bind(verifier);
  verifier.verifyAct = async (request, buildCtx) => {
    calls.verify++;
    return realVerify(request, buildCtx);
  };
  return { writer, verifier, calls, log };
}

async function run(b: ReturnType<typeof builders>, roundPolicy?: ActRoundPolicy, act0: SourcedAct = wideAct()): Promise<{ act: WrittenAct; stats: NarrationWriteStats }> {
  const stats: NarrationWriteStats = { retryRounds: 0 };
  const [act] = await writeNarration([act0], { writer: b.writer, verifier: b.verifier, evidence: gatherer(), stats, ...(roundPolicy ? { roundPolicy } : {}) }, voice, ctx);
  return { act: act!, stats };
}

type Page = NarratedBeat;
const pagesOf = (act: WrittenAct): Page[] => allWrittenNarration([act]);
/** The page of narration seam i (one page per seam, in play order). */
const pageOfSeam = (act: WrittenAct, i: number): Page => pagesOf(act)[i]!;

const TIMED = roundPolicyFor({ roundPolicy: "timed" }, "short");

/* ------------------------------------------------------------ the policy */

describe("GV-80 — roundPolicyFor", () => {
  it("default is today's three whole-act rounds; timed is two rounds of seam edits on every tier; the fast path sets timed", () => {
    /* MUTATION THAT KILLS THIS: return TIMED_ACT_ROUND_POLICY for every
       flag value in `roundPolicyFor` -- the default row reads {2, seams}.
       Or: drop a tier from TIMED_ROUND_POLICY_TIERS -- that tier reads
       today's policy under the timed flag. */
    expect(roundPolicyFor(CLASSIC_PIPELINE_FLAGS)).toEqual({ maxRounds: NARRATION_PAGE_ATTEMPTS, editScope: "act" });
    expect(roundPolicyFor(CLASSIC_PIPELINE_FLAGS, "short")).toEqual(DEFAULT_ACT_ROUND_POLICY);
    expect(NARRATION_PAGE_ATTEMPTS).toBe(3);
    for (const tier of ["short", "medium", "long"] as const) {
      expect(roundPolicyFor({ roundPolicy: "timed" }, tier)).toEqual({ maxRounds: 2, editScope: "seams" });
    }
    expect(roundPolicyFor({ roundPolicy: "timed" })).toEqual(TIMED_ACT_ROUND_POLICY);
    expect(roundPolicyFor(FAST_PATH_PIPELINE_FLAGS, "medium")).toEqual(TIMED_ACT_ROUND_POLICY);
    expect(roundPolicyFor(readPipelineFlags({}))).toEqual(DEFAULT_ACT_ROUND_POLICY);
    expect(roundPolicyFor(readPipelineFlags({ FORAY_ROUND_POLICY: "timed" }), "long")).toEqual(TIMED_ACT_ROUND_POLICY);
    expect(roundPolicyFor(readPipelineFlags({ FORAY_FAST_PATH: "1", FORAY_ROUND_POLICY: "default" }), "short")).toEqual(DEFAULT_ACT_ROUND_POLICY);
    /* A fresh object each call: a caller mutating its copy cannot move the
       shared constants. */
    const mine = roundPolicyFor({ roundPolicy: "timed" });
    mine.maxRounds = 9;
    expect(TIMED_ACT_ROUND_POLICY.maxRounds).toBe(2);
  });
});

describe("GV-80 — the default policy is today's rounds", () => {
  it("a beat the writer never carries costs three whole-act rounds, editSeams is never called, and the omitted and explicit default policies write the same act", async () => {
    /* MUTATION THAT KILLS THIS: bound the round loop by
       TIMED_ACT_ROUND_POLICY.maxRounds (or `?? 2`) instead of
       NARRATION_PAGE_ATTEMPTS when no policy is set -- three becomes two.
       Or: take the seam-edit branch whenever the writer offers `editSeams`
       (ignore `editScope`) -- editSeams is called on the default policy. */
    const omitted = builders({ failRounds: [1, 2, 3] });
    const a = await run(omitted);
    expect(omitted.calls).toEqual({ writeAct: 3, editSeams: 0, verify: 3 });
    expect(a.stats.retryRounds).toBe(2);
    /* Whole-act retries: round 2 re-sends every seam and every document. */
    const [r1, r2] = omitted.log.map((e) => e.request as ActWriteRequest);
    expect(r2!.seams.map((s) => s.seamId)).toEqual(r1!.seams.map((s) => s.seamId));
    expect(r2!.documents).toEqual(r1!.documents);
    expect(r1!.seams).toHaveLength(CLIPS + 1);

    const explicit = builders({ failRounds: [1, 2, 3] });
    const b = await run(explicit, roundPolicyFor(CLASSIC_PIPELINE_FLAGS, "short"));
    expect(explicit.calls).toEqual({ writeAct: 3, editSeams: 0, verify: 3 });
    expect(b.act).toEqual(a.act);
    expect(explicit.log.map((e) => e.request)).toEqual(omitted.log.map((e) => e.request));

    /* The failing seam ends as finalPageFor has always ended it: confirmed
       text kept, unverified, the beat named, three attempts. */
    const page = pageOfSeam(a.act, 3);
    expect(page.verified).toBe(false);
    expect(page.verifierNotes).toMatch(new RegExp(FAILING_BEAT));
    expect(page.attempts).toHaveLength(3);
  });
});

/* ------------------------------------------------------- the timed policy */

describe("GV-80 — the timed policy edits only the failing seams", () => {
  it("one seam failing in round 1: exactly two writer calls, the second an editSeams call holding that seam, its two neighbours, its two clips and the documents it cites, under 25% of round 1's size", async () => {
    /* MUTATION THAT KILLS THIS: send `documents` unfiltered in
       `seamEditRequestOf` (or every clip) -- the size check fails and the
       document ids read the whole act. Or: drop the neighbours -- the
       neighbour ids read []. Or: call `writeAct` in round 2 regardless of
       `editScope` -- editSeams reads 0 calls. */
    const b = builders({ failRounds: [1] });
    const { act, stats } = await run(b, TIMED);

    expect(b.calls).toEqual({ writeAct: 1, editSeams: 1, verify: 2 });
    expect(b.log.map((e) => e.kind)).toEqual(["writeAct", "editSeams"]);
    expect(stats.retryRounds).toBe(1);

    const round1 = b.log[0]!.request as ActWriteRequest;
    const edit = b.log[1]!.request as SeamEditRequest;
    expect(edit.seams.map((s) => s.seamId)).toEqual([FAILING_SEAM]);
    expect(edit.seams[0]!.previousScript).toContain("That thread runs further");
    expect(edit.seams[0]!.notes).toMatch(new RegExp(`does not carry beat ${FAILING_BEAT}`));
    expect(edit.seams[0]!.frozen).toBeUndefined();
    expect(edit.neighbours.map((n) => n.seamId)).toEqual(["s2", "s4"]);
    /* A neighbour is its current text, exactly as round 1 left it. */
    const s2Page = pageOfSeam(act, 2);
    expect(edit.neighbours[0]!.script).toBe(s2Page.script);
    expect(edit.clips.map((c) => c.clipId)).toEqual(["c2", "c3"]);
    /* What s3 cites: what its round-1 reply cited (only c3's window -- the
       scripted failure dropped the beat's quote of the act's first print),
       its beat's own evidence (the windows either side and its own print),
       and the windows of the clips it follows and introduces -- once each,
       in the act's document order. Nine prints and eight windows stay out. */
    expect(edit.documents.map((d) => d.docId)).toEqual([tapeDocIdFor(segmentOf(2)), tapeDocIdFor(segmentOf(3)), "print:survey-d"]);
    expect(round1.documents).toHaveLength(2 * CLIPS + 1);
    expect(edit.retryNote).toMatch(new RegExp(FAILING_BEAT));
    expect(edit.actTitle).toBe(round1.actTitle);
    expect(edit.voice).toEqual(voice);
    expect("frame" in edit).toBe(false);

    const editSize = JSON.stringify(edit).length;
    const round1Size = JSON.stringify(round1).length;
    expect(editSize).toBeLessThan(round1Size * 0.25);

    /* The edit carried the beat: s3 verified in round 2, every other seam
       verified in round 1 and untouched. */
    const page = pageOfSeam(act, 3);
    expect(page.verified).toBe(true);
    expect(page.attempts).toHaveLength(2);
    expect(computeUnverifiedPages([act]).count).toBe(0);
    for (const [i, p] of pagesOf(act).entries()) {
      if (i === 3) continue;
      expect(p.verified).toBe(true);
      expect(p.attempts).toHaveLength(1);
    }
  });

  it("frozen seams are never in an edit request, and keep their confirmed text whatever the edit returns", async () => {
    /* MUTATION THAT KILLS THIS: `failingSeams` returning every seam (drop
       the `!s.frozen` filter) -- the edit request lists all eleven seams.
       (A frozen seam the edit returns rewritten is kept as confirmed by
       `mechanicalPass` and `padSeamEdit` alike; the pages below pin that.) */
    const reference = builders();
    const clean = await run(reference, TIMED);
    expect(reference.calls).toEqual({ writeAct: 1, editSeams: 0, verify: 1 });

    /* The edit also returns a rewritten s2 it was never asked for. */
    const b = builders({
      failRounds: [1],
      mutateEdit: (reply) => ({ seams: [...reply.seams, { seamId: "s2", script: "A different script nobody asked for.", claims: [], usedClaims: [], pronunciationHints: [] }] })
    });
    const { act } = await run(b, TIMED);
    const edit = b.log[1]!.request as SeamEditRequest;
    expect(edit.seams.every((s) => s.frozen !== true)).toBe(true);
    expect(edit.seams.map((s) => s.seamId)).toEqual([FAILING_SEAM]);

    for (const [i, p] of pagesOf(act).entries()) {
      if (i === 3) continue;
      expect(p.script).toBe(pageOfSeam(clean.act, i).script);
      expect(p.verified).toBe(true);
    }
    /* s3 ends exactly as a clean run writes it. */
    expect(pageOfSeam(act, 3).script).toBe(pageOfSeam(clean.act, 3).script);
  });

  it("a clean silent seam is no failure: it stays out of the edit request and is padded back as silence", async () => {
    /* MUTATION THAT KILLS THIS: use the edit reply unpadded
       (`reply = edited`) -- the silent seam comes back missing, is refused
       "returned no script", and the act gains a refusal and loses its
       silence. Or: drop `!s.silent` from `failingSeams` -- the silent seam
       is in the edit request. */
    const reference = builders();
    const clean = await run(reference, TIMED, wideAct({ hostedClip: true }));
    expect(reference.calls.writeAct).toBe(1);
    const silent = (reference.log[0]!.request as ActWriteRequest).seams.find((s) => s.beats.length === 0 && s.intro === "none");
    expect(silent).toBeDefined();

    const b = builders({ failRounds: [1] });
    const { act } = await run(b, TIMED, wideAct({ hostedClip: true }));
    expect(b.calls).toEqual({ writeAct: 1, editSeams: 1, verify: 2 });
    const edit = b.log[1]!.request as SeamEditRequest;
    expect(edit.seams.map((s) => s.seamId)).toEqual([FAILING_SEAM]);
    expect(pagesOf(act).map((p) => p.script)).toEqual(pagesOf(clean.act).map((p) => p.script));
    expect(pagesOf(act).every((p) => p.verified)).toBe(true);
    expect(pageOfSeam(act, 3).attempts).toHaveLength(2);

    /* With a third round available, a silent seam refused for coming back
       missing would cost it: padded, round 2 settles the act. */
    const roomy = builders({ failRounds: [1] });
    await run(roomy, { maxRounds: 3, editScope: "seams" }, wideAct({ hostedClip: true }));
    expect(roomy.calls).toEqual({ writeAct: 1, editSeams: 1, verify: 2 });
  });

  it("a seam still failing after the edit round ends unverified, as finalPageFor ends it, after two rounds", async () => {
    /* MUTATION THAT KILLS THIS: keep NARRATION_PAGE_ATTEMPTS as the loop
       bound (ignore `maxRounds`) -- a third writer call follows. */
    const b = builders({ failRounds: [1, 2] });
    const { act, stats } = await run(b, TIMED);
    expect(b.calls).toEqual({ writeAct: 1, editSeams: 1, verify: 2 });
    expect(stats.retryRounds).toBe(1);

    const page = pageOfSeam(act, 3);
    expect(page.verified).toBe(false);
    expect(page.verifierNotes).toMatch(new RegExp(FAILING_BEAT));
    expect(page.attempts).toHaveLength(2);
    const unverified = computeUnverifiedPages([act]);
    expect(unverified.count).toBe(1);

    /* The same page the default policy ends with after three rounds, but
       for the attempt history. */
    const dflt = builders({ failRounds: [1, 2, 3] });
    const reference = await run(dflt);
    const withoutAttempts = (p: Page): Partial<Page> => {
      const copy: Partial<Page> = { ...p };
      delete copy.attempts;
      return copy;
    };
    expect(withoutAttempts(page)).toEqual(withoutAttempts(pageOfSeam(reference.act, 3)));
  });

  it("a writer without editSeams falls back to a whole-act round 2, two rounds at most", async () => {
    /* MUTATION THAT KILLS THIS: bound the loop by NARRATION_PAGE_ATTEMPTS
       when the writer has no `editSeams` -- three writeAct calls. Or: call
       `writer.editSeams!` without checking it exists -- a TypeError. */
    const b = builders({ failRounds: [1, 2, 3], withEditSeams: false });
    const { act, stats } = await run(b, TIMED);
    expect(b.calls).toEqual({ writeAct: 2, editSeams: 0, verify: 2 });
    expect(stats.retryRounds).toBe(1);
    const [r1, r2] = b.log.map((e) => e.request as ActWriteRequest);
    expect(r2!.seams.map((s) => s.seamId)).toEqual(r1!.seams.map((s) => s.seamId));
    expect(r2!.documents).toEqual(r1!.documents);
    expect(pageOfSeam(act, 3).verified).toBe(false);
  });

  it("the stub's editSeams writes only the requested seams, against the request's own clips and documents", async () => {
    /* MUTATION THAT KILLS THIS: have the stub's `editSeams` write
       `stubSeam` with an empty clip map -- the full introduction of c3 loses
       its window claim. Or: write every seam it knows of -- the reply has
       more than one seam. */
    const b = builders({ failRounds: [1] });
    await run(b, TIMED);
    const edit = b.log[1]!.request as SeamEditRequest;
    const stub = new StubNarrationWriterBuilder();
    const reply = await stub.editSeams(edit, ctx);
    expect(reply.seams.map((s) => s.seamId)).toEqual([FAILING_SEAM]);
    const docIds = new Set(edit.documents.map((d) => d.docId));
    expect(reply.seams[0]!.claims.every((c) => docIds.has(c.docId))).toBe(true);
    expect(reply.seams[0]!.claims.some((c) => c.docId === tapeDocIdFor(segmentOf(3)))).toBe(true);
    expect(reply.seams[0]!.claims.some((c) => c.claimText === FAILING_CLAIM)).toBe(true);
  });
});
