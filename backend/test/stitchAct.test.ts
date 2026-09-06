import { describe, it, expect } from "vitest";
import { stitchAct, countActBeats, TEXTURE_CADENCE_SEC } from "../src/generation/stitchAct";
import { validateActCoverage } from "../src/types/stitching";
import type { WrittenAct, WrittenBeat } from "../src/generation/writeNarration";
import type { TapePointer } from "../src/types/tapeSourcing";
import type { NarratedBeat } from "../src/types/narration";

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
