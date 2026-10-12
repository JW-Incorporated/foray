import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  cutPassages,
  cutPassageSpans,
  keyPassages,
  passageId,
  PASSAGE_INDEX_VERSION,
  PASSAGE_MAX_SEC,
  PASSAGE_TARGET_MIN_SEC,
  type Passage
} from "../src/generation/passageCutter";
import { cuesFromBodyJson, type TranscriptCue } from "../src/generation/transcriptArchiveLookup";
import { phraseIsInWindow } from "../src/types/anchorText";

/**
 * GV-12 (docs/roadmap/generation-v2.md, from W3-23): whole-thought passages
 * cut by sourcing's own boundary rules, with offline anchors and the two edge
 * kinds kept apart. Synthetic cues only: speaker turns, sentence ends with and
 * without a pause, a hole in the tape, a letter-spaced cue, one-word edge cues
 * (the anchor spill) and a thirty-minute monologue with no boundary at all.
 */

const KEY = { show_id: "gv12-show", guid: "gv12-episode" };

const VOCAB = [
  "engine", "bridge", "river", "copper", "harvest", "lantern", "granite", "orbit",
  "signal", "marble", "falcon", "meadow", "canyon", "glacier", "harbor", "violin",
  "compass", "thunder", "saddle", "furnace", "ledger", "quarry", "orchard", "pigeon"
];

/** A cue's worth of distinct speech; `end` is its closing punctuation. */
function speech(i: number, end: string): string {
  const w = (j: number) => VOCAB[(i * 5 + j) % VOCAB.length]!;
  return `the ${w(0)} beside the ${w(1)} shaped the ${w(2)} and ${w(3)}${end}`;
}

function cue(text: string, start: number, end: number, speaker?: string): TranscriptCue {
  return { text, start_sec: start, end_sec: end, speaker: speaker ?? null };
}

/** Tiling: cue ranges contiguous from the first cue to the last, seconds never
 * overlapping, every passage but the last within [TARGET_MIN, MAX_SEC], each
 * anchor in its own text. */
function expectTiles(passages: readonly Passage[], cueCount: number): void {
  expect(passages.length).toBeGreaterThan(0);
  expect(passages[0]!.firstCue).toBe(0);
  expect(passages[passages.length - 1]!.lastCue).toBe(cueCount - 1);
  passages.forEach((p, i) => {
    expect(p.lastCue).toBeGreaterThanOrEqual(p.firstCue);
    expect(p.endSec).toBeGreaterThan(p.startSec);
    if (i > 0) {
      expect(p.firstCue).toBe(passages[i - 1]!.lastCue + 1);
      expect(p.startSec).toBeGreaterThanOrEqual(passages[i - 1]!.endSec);
    }
    if (i < passages.length - 1) {
      expect(p.endSec - p.startSec).toBeGreaterThanOrEqual(PASSAGE_TARGET_MIN_SEC);
      expect(p.endSec - p.startSec).toBeLessThanOrEqual(PASSAGE_MAX_SEC);
    }
    for (const anchor of [p.startAnchor, p.endAnchor]) {
      expect(anchor).not.toBeNull();
      expect(phraseIsInWindow(anchor!, p.text)).toBe(true);
    }
  });
}

const shape = (passages: readonly Passage[]) => passages.map((p) => [p.firstCue, p.lastCue, p.startBoundary, p.endBoundary]);

/**
 * Fifty cues, 9 s of speech and a 1 s pause each. A cue ending in "." before a
 * pause is a sentence boundary; every other cue ends in ",". Cue 10 ends in
 * "." too, but only 0.1 s before the next cue: no pause, no boundary. Cues 12
 * and 25 are one word ("Right," / "Yes."), so their anchors must spill into
 * the neighbouring cues.
 */
function pausedMonologue(): TranscriptCue[] {
  const sentenceEnds = new Set([4, 11, 13, 25, 40]);
  const cues: TranscriptCue[] = [];
  for (let k = 0; k < 50; k++) {
    let text = speech(k, sentenceEnds.has(k) || k === 10 ? "." : ",");
    if (k === 12) text = "Right,";
    if (k === 25) text = "Yes.";
    cues.push(cue(text, 10 * k, k === 10 ? 10 * k + 9.9 : 10 * k + 9));
  }
  return cues;
}

describe("cutPassages — whole-thought passages (GV-12)", () => {
  it("closes each passage at the first sentence boundary after the target minimum, skipping a sentence end with no pause", () => {
    /* MUTATIONS THAT KILL THIS: start the reach loop with no minimum (replace
       PASSAGE_TARGET_MIN_SEC with 0 in the reach loop) — the first passage
       closes at cue 4 (49 s). */
    const cues = pausedMonologue();
    const passages = cutPassages(KEY, cues);
    expect(shape(passages)).toEqual([
      [0, 11, "sentence", "sentence"],
      [12, 25, "sentence", "sentence"],
      [26, 40, "sentence", "sentence"],
      [41, 49, "sentence", "sentence"]
    ]);
    expect(passages.map((p) => [p.startSec, p.endSec])).toEqual([
      [0, 119],
      [120, 259],
      [260, 409],
      [410, 499]
    ]);
    expectTiles(passages, cues.length);
    expect(passages.every((p) => p.indexVersion === PASSAGE_INDEX_VERSION)).toBe(true);
    /* Strict edges: the passage quotes its own cues and no neighbour's. */
    expect(passages[1]!.text.startsWith("Right,")).toBe(true);
    expect(passages[1]!.text.endsWith("Yes.")).toBe(true);
    expect(passages[0]!.text).not.toContain("Right,");
  });

  it("an edge cue too short to quote spills its anchor into the passage's next (or previous) cues", () => {
    /* MUTATION THAT KILLS THIS: in startAnchorFor / endAnchorFor return the
       edge cue's own mint with no spill — "Right," and "Yes." yield nothing
       and the anchors are null. */
    const passage = cutPassages(KEY, pausedMonologue())[1]!;
    expect(passage.startAnchor).not.toBeNull();
    expect(passage.endAnchor).not.toBeNull();
    expect(phraseIsInWindow(passage.startAnchor!, passage.text)).toBe(true);
    expect(phraseIsInWindow(passage.endAnchor!, passage.text)).toBe(true);
  });

  it("with speaker turns: a turn ends a passage, and with no boundary inside the target the cut falls at MAX_SEC, start and end kinds kept apart", () => {
    /* Every cue ends in "." but only 0.2 s before the next: no pause, so only
       turns are boundaries. Speaker A for cues 0-9, B for 10-60.
       MUTATIONS THAT KILL THIS: report the start edge as the end edge
       (startBoundary: endBoundary) — passage 1 reads cue/cue; drop the
       MAX_SEC branch's own cut and close at the target ceiling instead
       (replace PASSAGE_MAX_SEC with PASSAGE_TARGET_MAX_SEC there) — passage 1
       ends at cue 27, not 33. */
    const cues: TranscriptCue[] = [];
    for (let k = 0; k <= 60; k++) cues.push(cue(speech(k, "."), 10 * k, 10 * k + 9.8, k < 10 ? "A" : "B"));
    const passages = cutPassages(KEY, cues);
    expect(shape(passages)).toEqual([
      [0, 9, "turn", "turn"],
      [10, 33, "turn", "cue"],
      [34, 57, "cue", "cue"],
      [58, 60, "cue", "turn"]
    ]);
    expectTiles(passages, cues.length);
  });

  it("a hole in the tape is a sentence edge, a turn inside the target beats an earlier sentence boundary, and a boundary past the target is not taken", () => {
    /* MUTATION THAT KILLS THIS: in endEdgeKind / the hit branch, label every
       boundary "turn" — the hole's edge reads turn. */
    const holeCues: TranscriptCue[] = [];
    for (let k = 0; k < 25; k++) {
      const start = 10 * k + (k >= 13 ? 6 : 0);
      holeCues.push(cue(speech(k, ""), start, start + 10));
    }
    const hole = cutPassages(KEY, holeCues);
    expect(shape(hole)[0]).toEqual([0, 12, "sentence", "sentence"]);
    expect(hole[1]!.startBoundary).toBe("sentence");

    /* With turns: a paused sentence end at cue 10 (end ~110 s) and a turn at
       cue 15: nearestEndBoundary prefers the turn inside the target. */
    const turnCues: TranscriptCue[] = [];
    for (let k = 0; k < 30; k++) {
      const end = 10 * k + (k === 10 ? 9 : 9.8);
      turnCues.push(cue(speech(k, k === 10 ? "." : ","), 10 * k, end, k < 15 ? "A" : "B"));
    }
    expect(shape(cutPassages(KEY, turnCues))[0]).toEqual([0, 14, "turn", "turn"]);

    /* A sentence boundary past TARGET_MAX (cue 20 ends at 210 s) is not a
       target boundary: the cut falls at MAX_SEC on a bare cue edge.
       MUTATION THAT KILLS THIS: pass startSec + PASSAGE_MAX_SEC as
       nearestEndBoundary's ceiling — the passage closes at cue 20. */
    const lateCues: TranscriptCue[] = [];
    for (let k = 0; k < 40; k++) lateCues.push(cue(speech(k, k === 20 ? "." : ""), 10 * k, 10 * k + (k === 20 ? 9 : 10)));
    expect(shape(cutPassages(KEY, lateCues))[0]).toEqual([0, 23, "sentence", "cue"]);
  });

  it("a thirty-minute monologue with no boundary is cut every MAX_SEC at a cue edge", () => {
    /* MUTATION THAT KILLS THIS: in the no-boundary branch close at the episode's
       last cue (last = n - 1) — one 1,800 s passage. */
    const cues: TranscriptCue[] = [];
    for (let k = 0; k < 180; k++) cues.push(cue(speech(k, ""), 10 * k, 10 * k + 10));
    const passages = cutPassages(KEY, cues);
    expect(passages.map((p) => [p.startSec, p.endSec])).toEqual([
      [0, 240],
      [240, 480],
      [480, 720],
      [720, 960],
      [960, 1200],
      [1200, 1440],
      [1440, 1680],
      [1680, 1800]
    ]);
    expect(passages.map((p) => p.startBoundary)).toEqual(["sentence", "cue", "cue", "cue", "cue", "cue", "cue", "cue"]);
    expect(passages.map((p) => p.endBoundary)).toEqual(["cue", "cue", "cue", "cue", "cue", "cue", "cue", "sentence"]);
    expectTiles(passages, cues.length);
  });

  it("a letter-spaced cue never reaches a passage: the reading filter drops it before the cut", () => {
    const raw = [cue("T r a n s c r i p t - E p i s o d e # 5 9 5", 0, 4)];
    for (let k = 0; k < 12; k++) raw.push(cue(speech(k, k === 11 ? "." : ","), 4 + 10 * k, 4 + 10 * k + 9));
    const cues = cuesFromBodyJson({ cues: raw })!;
    const passages = cutPassages(KEY, cues);
    expect(passages).toHaveLength(1);
    expect(passages[0]!.startSec).toBe(4);
    expect(passages[0]!.text).not.toContain("T r a n");
    expect(passages[0]!.startAnchor).not.toMatch(/\bt r a n\b/);
    expectTiles(passages, cues.length);
  });

  it("overlapping cue timings never make two passages overlap in seconds", () => {
    /* MUTATION THAT KILLS THIS: open each passage at its first cue's own start
       (drop the Math.max with the previous passage's end). */
    /* A turn at cue 10, whose cue starts 0.8 s before cue 9 has ended. */
    const cues: TranscriptCue[] = [];
    for (let k = 0; k < 20; k++) cues.push(cue(speech(k, ","), k === 10 ? 99 : 10 * k, 10 * k + 9.8, k < 10 ? "A" : "B"));
    const passages = cutPassages(KEY, cues);
    expect(passages[1]!.firstCue).toBe(10);
    expect(passages[1]!.startSec).toBe(99.8);
    expectTiles(passages, cues.length);
  });

  it("ids are the first 16 hex of sha1(show_id|guid|startSec|endSec): deterministic, and different for another archive guid", () => {
    /* MUTATION THAT KILLS THIS: leave the guid out of passageId's hash input —
       the two keys' ids collide. */
    const cues = pausedMonologue();
    const a = cutPassages(KEY, cues);
    expect(cutPassages(KEY, cues)).toEqual(a);
    const p = a[2]!;
    expect(p.id).toBe(createHash("sha1").update(`${KEY.show_id}|${KEY.guid}|${p.startSec}|${p.endSec}`).digest("hex").slice(0, 16));
    expect(p.id).toBe(passageId(KEY, p.startSec, p.endSec));
    const other = keyPassages({ show_id: KEY.show_id, guid: "another-guid" }, cutPassageSpans(cues));
    expect(other.map((x) => x.guid)).toEqual(a.map(() => "another-guid"));
    expect(other.map((x) => x.id).filter((id) => a.some((y) => y.id === id))).toEqual([]);
    expect(new Set(a.map((x) => x.id)).size).toBe(a.length);
    expect(cutPassages(KEY, [])).toEqual([]);
  });
});
