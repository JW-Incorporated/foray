import { describe, it, expect } from "vitest";
import { stitchAct, countActBeats, TEXTURE_CADENCE_SEC } from "../src/generation/stitchAct";
import { validateActCoverage } from "../src/types/stitching";
import type { WrittenAct, WrittenBeat } from "../src/generation/writeNarration";
import type { TapePointer } from "../src/types/tapeSourcing";
import type { NarratedBeat, Source } from "../src/types/narration";

function tapePointer(itemId: string, startSec: number, endSec: number): TapePointer {
  return {
    segmentId: `${itemId}#${startSec}`,
    itemId,
    startSec,
    endSec,
    startAnchor: "so the first thing to understand is",
    endAnchor: "and that changed everything after that",
    tier: 1,
    confidence: "high"
  };
}

function narratedBeat(script = "A short bridging line that connects two pieces of tape together for the listener."): NarratedBeat {
  return { mode: "Frame", script, sources: [], pronunciationHints: [], verified: true };
}

function tapeBeat(claim: string, itemId: string, startSec: number, endSec: number, connective?: NarratedBeat): WrittenBeat {
  const beat: WrittenBeat = { sourcing: "tape", claim, exploration: false, tape: tapePointer(itemId, startSec, endSec) };
  if (connective) return { ...beat, connectiveNarration: connective };
  return beat;
}

function narrationBeat(claim: string): WrittenBeat {
  return { sourcing: "narration", claim, exploration: false, narration: narratedBeat(claim) };
}

function makeAct(slots: WrittenAct["slots"]): WrittenAct {
  return { title: "Test act", slots };
}

describe("stitchAct — rule 1: silence is a valid bridge", () => {
  it("inserts nothing between two adjacent same-episode tape items with no connective narration", () => {
    const act = makeAct([
      {
        title: "slot 1",
        beats: [tapeBeat("First claim.", "ep-1", 0, 30), tapeBeat("Second claim.", "ep-1", 30, 60)]
      }
    ]);

    const stitched = stitchAct(act, "act-1");

    // No jingle, no narration item between the two tape items.
    const kinds = stitched.items.map((i) => i.kind);
    expect(kinds).toEqual(["tape", "tape"]);
  });
});

describe("stitchAct — F-96: a clip carrying two beats plays once", () => {
  it("emits one tape item for two beats that point at the same segment, and covers both beats", () => {
    /* §4.5 merges a beat whose thought sits in the stretch an earlier beat's
       clip covers into that clip: both beats carry the same pointer. The clip
       plays once, on the first beat; the second beat's claim is in the tape
       already playing, so it emits nothing — not its item, not a connective
       — and coverage still records it. A narration beat between them keeps
       its page. MUTATION THAT KILLS THIS: drop the `emittedSegments` test —
       the segment appears twice and `check-forays.mjs` refuses the Foray. */
    const act = makeAct([
      {
        title: "slot 1",
        beats: [
          tapeBeat("First claim.", "ep-1", 100, 240),
          narrationBeat("A bridge."),
          tapeBeat("Second claim, carried by the same clip.", "ep-1", 100, 240, narratedBeat("An intro that has nothing to introduce."))
        ]
      }
    ]);
    const stitched = stitchAct(act, "act-1");
    expect(stitched.items.map((i) => i.kind)).toEqual(["tape", "narration"]);
    expect(stitched.items.filter((i) => i.kind === "tape")).toHaveLength(1);
    expect(stitched.coverage.entries).toHaveLength(3);
    expect(validateActCoverage(stitched.coverage, countActBeats(act)).valid).toBe(true);
  });
});

describe("stitchAct — rule 2: the jingle marks a change of tape", () => {
  it("never leaves two consecutive cross-episode tape items with nothing between (jingle backstop)", () => {
    const act = makeAct([
      {
        title: "slot 1",
        beats: [tapeBeat("First claim.", "ep-1", 0, 30), tapeBeat("Second claim.", "ep-2", 0, 30)]
      }
    ]);

    const stitched = stitchAct(act, "act-1");
    const kinds = stitched.items.map((i) => i.kind);
    // tape, [jingle or narration], tape — never tape immediately followed by tape.
    expect(kinds[0]).toBe("tape");
    expect(kinds[kinds.length - 1]).toBe("tape");
    expect(kinds.length).toBeGreaterThan(2);
    for (let i = 0; i < kinds.length - 1; i++) {
      if (kinds[i] === "tape" && kinds[i + 1] === "tape") {
        throw new Error("two consecutive tape items with nothing between them on a cross-episode cut");
      }
    }
  });

  it("relies on connective narration when §4.7 already wrote a Frame for the cut, and does not ALSO insert a jingle", () => {
    const act = makeAct([
      {
        title: "slot 1",
        beats: [tapeBeat("First claim.", "ep-1", 0, 30), tapeBeat("Second claim.", "ep-2", 0, 30, narratedBeat())]
      }
    ]);

    const stitched = stitchAct(act, "act-1");
    const kinds = stitched.items.map((i) => i.kind);
    expect(kinds).toEqual(["tape", "narration", "tape"]);
  });
});

describe("stitchAct — rule 3: texture on a cadence (measured, not guessed)", () => {
  it("cites the real measured constant, not a round guess", () => {
    expect(TEXTURE_CADENCE_SEC).toBe(155);
  });

  it("inserts a cadence jingle when accumulated same-episode silent time exceeds the measured threshold", () => {
    const longSegmentSec = TEXTURE_CADENCE_SEC + 10;
    const act = makeAct([
      {
        title: "slot 1",
        beats: [
          tapeBeat("First claim.", "ep-1", 0, longSegmentSec),
          tapeBeat("Second claim.", "ep-1", longSegmentSec, longSegmentSec + 30)
        ]
      }
    ]);

    const stitched = stitchAct(act, "act-1");
    const jingle = stitched.items.find((i) => i.kind === "jingle");
    expect(jingle).toBeDefined();
    expect(jingle && jingle.kind === "jingle" && jingle.reason).toBe("cadence");
  });

  it("stays silent (rule 1) when accumulated same-episode silent time is under the measured threshold", () => {
    const shortSegmentSec = TEXTURE_CADENCE_SEC - 50;
    const act = makeAct([
      {
        title: "slot 1",
        beats: [
          tapeBeat("First claim.", "ep-1", 0, shortSegmentSec),
          tapeBeat("Second claim.", "ep-1", shortSegmentSec, shortSegmentSec + 30)
        ]
      }
    ]);

    const stitched = stitchAct(act, "act-1");
    const kinds = stitched.items.map((i) => i.kind);
    expect(kinds).toEqual(["tape", "tape"]);
  });
});

describe("stitchAct — rule 4: coverage is checked before flow", () => {
  it("gives every beat a coverage entry, and validateActCoverage passes", () => {
    const act = makeAct([
      {
        title: "slot 1",
        beats: [tapeBeat("First claim.", "ep-1", 0, 30), narrationBeat("Second claim."), tapeBeat("Third claim.", "ep-2", 0, 30)]
      }
    ]);

    const stitched = stitchAct(act, "act-1");
    const totalBeats = countActBeats(act);
    expect(stitched.coverage.entries).toHaveLength(totalBeats);

    const result = validateActCoverage(stitched.coverage, totalBeats);
    expect(result.valid).toBe(true);
    expect(result.issues).toEqual([]);
  });

  it("flags a beat with no coverage entry at all as a hard failure, never a silent pass", () => {
    // Simulate a stitcher that dropped a beat's coverage entry entirely
    // (deliberately malformed — not achievable via stitchAct's own
    // normal path, which always emits one entry per beat; this is the
    // structural gate `validateActCoverage` provides against that class
    // of bug, per stitching.ts's own doc comment).
    const totalBeats = 3;
    const result = validateActCoverage({ entries: [{ status: "present", beatIndex: 0, claim: "a" }, { status: "present", beatIndex: 2, claim: "c" }] }, totalBeats);
    expect(result.valid).toBe(false);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]!.beatIndex).toBe(1);
  });

  it("accepts an explicitly-dropped beat with a reason as valid coverage", () => {
    const totalBeats = 2;
    const result = validateActCoverage(
      { entries: [{ status: "present", beatIndex: 0, claim: "a" }, { status: "dropped", beatIndex: 1, claim: "b", reason: "duplicate of beat 0" }] },
      totalBeats
    );
    expect(result.valid).toBe(true);
  });
});

describe("stitchAct — F-103: the page's provenance survives the stitch", () => {
  const printSource = (claimText: string): Source => ({
    claimText,
    publication: "Journal of Human Evolution",
    url: "https://example.org/paper",
    quote: "the earliest secure evidence of controlled fire",
    contested: false
  });

  it("carries `sources` and `verified` from a narration beat's page onto its stitched item", () => {
    /* THIS IS THE HOP THE PROVENANCE USED TO DIE AT. Before F-103 this module
       read `mode` and `script` off the `NarratedBeat` and nothing else — the
       verifier's answer to "what does this page rest on" reached §4.8 and
       stopped, which is why nothing downstream published citations: it had
       none to publish.
       MUTATION: delete the `...provenanceOf(beat.narration)` spread — this
       goes red here, and everything downstream silently publishes nothing,
       exactly as it did before. */
    const page: NarratedBeat = {
      mode: "Patch",
      script: "A page that carries the beat's content and cites the article it rests on.",
      sources: [printSource("Cooking predates anatomically modern humans.")],
      pronunciationHints: [],
      verified: true
    };
    const act = makeAct([{ title: "slot 1", beats: [{ sourcing: "narration", claim: "A claim.", exploration: false, narration: page }] }]);

    const [item] = stitchAct(act, "act-1").items;

    expect(item!.kind).toBe("narration");
    expect(item!).toMatchObject({ verified: true, sources: page.sources });
  });

  it("carries it from a CONNECTIVE page too — the Frame beside a clip is a page like any other", () => {
    /* Connective narration is a §4.7 decision rather than something
       `SourcedBeat` flags, so it is written and verified on its own path and
       is easy to forget when a field is added to the other one. The tape
       source shape (F-81) exists precisely for these pages, so a Frame is the
       single most likely narration item in a generated Foray to carry a
       citation at all.
       MUTATION: delete the spread on the connective branch only — every Frame
       in every Foray loses its tape credit while beat pages keep theirs. */
    const connective: NarratedBeat = {
      mode: "Frame",
      script: "A short bridging line that hands the listener into the clip that follows it.",
      sources: [
        { kind: "tape", claimText: "The guest describes the gut-reduction argument.", publication: "Origin Stories", contested: false, segmentId: "ep-2#30" }
      ],
      pronunciationHints: [],
      verified: true
    };
    const act = makeAct([
      { title: "slot 1", beats: [tapeBeat("First claim.", "ep-1", 0, 30), tapeBeat("Second claim.", "ep-2", 30, 60, connective)] }
    ]);

    const narrationItems = stitchAct(act, "act-1").items.filter((i) => i.kind === "narration");

    expect(narrationItems).toHaveLength(1);
    expect(narrationItems[0]).toMatchObject({ verified: true, sources: connective.sources });
  });

  it("copies `verified: false` verbatim rather than deciding anything about it", () => {
    /* F-51 keeps a refused page with `verified: false` instead of ending the
       run, and the decision about what that costs belongs to the veracity gate
       — not to a deterministic stitcher, and not to two places at once. This
       module copies; `forayItems.ts`'s `citesFor` is the single place that
       turns the flag into "publishes no citations".
       MUTATION: have this module drop `sources` when `!verified` — the honesty
       rule then lives in two modules that will eventually disagree, and the
       pipeline's own report loses the sources of every kept-unverified page. */
    const refused: NarratedBeat = {
      mode: "Patch",
      script: "A page the verifier read and objected to, kept for the gate to count.",
      sources: [printSource("A claim the verifier would not confirm.")],
      pronunciationHints: [],
      verified: false,
      verifierNotes: "the page states more than its sources carry"
    };
    const act = makeAct([{ title: "slot 1", beats: [{ sourcing: "narration", claim: "A claim.", exploration: false, narration: refused }] }]);

    const [item] = stitchAct(act, "act-1").items;

    expect(item).toMatchObject({ verified: false, sources: refused.sources });
  });
});
