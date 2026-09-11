import path from "node:path";
import { describe, expect, it } from "vitest";
import { deriveItemId, sourceBeats } from "../src/generation/sourceBeats";
import { buildCandidateFiles, mintedPoolCollisions } from "../src/generation/finalizeForay";
import { SEGMENT_START_TOLERANCE_SEC, segmentAtStart, startsCoincide, type SegmentRecord } from "../src/generation/segmentPoolLookup";
import { runtimeSecFor } from "../src/generation/runPipeline";
import { FileTranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import type { TranscriptBodySource, TranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import type { TranscriptCue, TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { allSourcedBeats, type NewSegment } from "../src/types/tapeSourcing";
import type { DeepenedAct } from "../src/types/spine";
import type { ForayItem } from "../src/generation/forayItems";

/**
 * F-84: A MINTED SEGMENT NEVER SITS BESIDE A COMMITTED ONE AT THE SAME START.
 *
 * Run 6 (2026-09-11, PR #624) cut a tier-2 segment of
 * `practical-ai--ai-policy-and-the-battle-for-computing-power` at 826.36 s
 * while `data/segments.json` already held `…#826` (826.36–921.04 s) from the
 * previous generated Foray. `mintSegmentId` suffixed the collision (`…#826-2`,
 * 826.36–957.07 s), the publish wrote both rows, and `merge-segments.mjs
 * --check` refused the PR ("id does not match its item_id + start_sec"); a
 * person repointed the Foray at `#826` and shrank its runtime by hand.
 *
 * The rule now lives at two seams, in the same words (`startsCoincide`):
 *   - SOURCING (`sourceBeats.ts`): before a tier-2 segment is minted, the pool
 *     is asked whether a committed row begins at the cut's start; if so the
 *     POOL'S cut is placed under the pool's id, nothing is minted, and the
 *     ledger judges that cut — a refused pool cut refuses the candidate
 *     (`pool-cut`) rather than minting a sibling.
 *   - PUBLISH (`finalizeForay.ts` / `publishForay.ts`): a minted row whose id
 *     is not `item_id#round(start)`, or that starts where a committed row of
 *     the same episode starts, or that would shadow its on-disk twin with a
 *     different cut, is refused before anything is written.
 *
 * MUTATIONS, each named in the test that kills it:
 *   - drop the `committedCutAt` check in `Tier2Walk.run`      → "reuses the pool id"
 *     (the mint throws on the id, or with the old suffix rule mints `…#100-2`)
 *   - report the reused cut with the tier-2 span's end          → "runtime follows"
 *   - order the runtime pool `[...disk, ...minted]` again       → "committed row wins"
 *   - refuse every same-episode mint, not just a same start     → "unrelated start"
 *   - mint a sibling when the pool's cut is refused              → "refused, never minted beside"
 *   - drop rule 1 / 2 / 3 of `mintedPoolCollisions`              → the three publish cases
 *   - drop the check from `buildCandidateFiles`                 → "finalize refuses"
 *   - widen or drop the half-second tolerance                   → "half a second"
 */

const FIXTURE_ROOT = path.resolve(__dirname, "..", "..", "tools", "foray", "fixtures", "boundary");
const TOPIC = "engineering/ai-robotics";

/* The WS-H episode and tape (`sourceBeats.test.ts`): a title that says nothing,
   a transcript that says the claim between 100 and 132 s. */
const episode: TranscriptDigestEntry = {
  show_id: "practical-ai",
  show_title: "Practical AI",
  guid: "pa-172",
  title: "Episode 172",
  cues: 5,
  feed_duration_sec: 3600,
  enclosure_url: "https://cdn.example/pa-172.mp3"
};
const ITEM_ID = deriveItemId(episode);

const cues: TranscriptCue[] = [
  { text: "welcome back to the show today we are talking about benchmarks", start_sec: 70, end_sec: 100 },
  { text: "the labels in that benchmark were wrong more often than anyone admitted", start_sec: 100, end_sec: 108 },
  { text: "an audit found thousands of mislabelled validation images across the whole benchmark", start_sec: 108, end_sec: 120 },
  { text: "and those wrong labels put a ceiling on the accuracy anyone could report", start_sec: 120, end_sec: 132 },
  { text: "we will come back to that after the break", start_sec: 132, end_sec: 150 }
];
const claim =
  "An audit found thousands of mislabelled validation images across the whole benchmark, and those wrong labels put a ceiling on the accuracy anyone could report.";

function textIndexOver(archive: TranscriptDigestEntry[], cuesByGuid: Record<string, TranscriptCue[]>): TranscriptTextIndex {
  const bodies: TranscriptBodySource = {
    getCues: (entry) => cuesByGuid[entry.guid] ?? null,
    bodyStat: (entry) => (cuesByGuid[entry.guid] ? { mtimeMs: 1, size: 1 } : null)
  };
  return new FileTranscriptTextIndex({ archive, bodies, cache: false });
}

/** One seeded beat: the seed pass runs BEFORE tier 1 (G-24 R2), which is the
 * run-6 shape — the pool row at the same start was never tier 1's to find. */
function seededAct(seedStart = 100, seedEnd = 132): DeepenedAct[] {
  return [
    {
      title: "Act A",
      thesis: "Act A establishes labels.",
      startState: "The listener does not know about labels.",
      endState: "The listener now understands labels.",
      slots: [{ title: "Labels", beats: [{ claim, exploration: false, kind: "account", seed: { episodeId: ITEM_ID, startSec: seedStart, endSec: seedEnd } }] }],
      introduction: "Intro",
      exit: "Exit"
    }
  ];
}

/** The committed row at the start tier 2's cut of this window reaches (100 s):
 * a different LENGTH from the 100–132 cut, so the two are told apart. Its start
 * is 0.2 s off the cue boundary — the float noise of another transcript read. */
function poolRowAt(startSec: number, endSec: number, id = `${ITEM_ID}#${Math.round(startSec)}`): SegmentRecord {
  return {
    id,
    item_id: ITEM_ID,
    topic: TOPIC,
    start_sec: startSec,
    end_sec: endSec,
    reference_duration_sec: 3600,
    start_anchor: "the labels in that benchmark were wrong",
    end_anchor: "we will come back to that after",
    why: "A benchmark's labels were wrong more often than anyone admitted.",
    confidence: "high",
    transcript_source: "publisher",
    dai_suspected: false,
    source: "agent-v1",
    batch_id: "seg-test",
    needs_review: false
  };
}

function run(segmentPool: SegmentRecord[], acts: DeepenedAct[] = seededAct()) {
  return sourceBeats(acts, {
    segmentPool,
    transcriptArchive: [episode],
    cueProvider: { getCues: () => cues },
    textIndex: textIndexOver([episode], { "pa-172": cues }),
    topic: TOPIC
  });
}

describe("F-84 at sourcing — a tier-2 cut at a start the pool holds reuses the pool's row", () => {
  it("reuses the pool id: no segment is minted, the beat points at the committed row, and no sibling exists", () => {
    const committed = poolRowAt(100.2, 150);
    const result = run([committed]);
    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing !== "tape") return;
    expect(beat.tape.segmentId).toBe(committed.id);
    expect(beat.tape.segmentId).not.toMatch(/-\d+$/);
    /* What plays is a `data/segments.json` row: tier 1, the pool's anchors and
       confidence, nothing to merge. */
    expect(beat.tape.tier).toBe(1);
    expect(beat.tape.startAnchor).toBe(committed.start_anchor);
    expect(beat.tape.confidence).toBe("high");
    expect(result.newSegments).toHaveLength(0);
    expect(result.newSegmentSources).toHaveLength(0);
    /* The relevance row says the archive search found the pool's cut (F-84),
       and that the seed window is what led there. */
    expect(result.tapeRelevance).toHaveLength(1);
    expect(result.tapeRelevance[0]).toMatchObject({ segmentId: committed.id, tier: 1, poolCut: "reused", seedWindowWon: true });
  });

  it("runtime follows the reused cut: the pointer carries the pool's end, not the window's, and the clock agrees", () => {
    const committed = poolRowAt(100.2, 150);
    const result = run([committed]);
    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing !== "tape") return;
    /* The tier-2 window would have been cut 100–132 (32 s); the pool's cut is
       100.2–150 (49.8 s). The Foray is timed on the cut it references. */
    expect(beat.tape.startSec).toBe(100.2);
    expect(beat.tape.endSec).toBe(150);
    const items: ForayItem[] = [{ type: "segment", slot: "labels", label: "L-1", segment_id: beat.tape.segmentId, role: "explanation" }];
    expect(runtimeSecFor(items, [committed])).toBeCloseTo(49.8, 6);
    /* And the sourcing ledger placed the pool's duration, not the window's —
       the length rules downstream were asked about what will actually play. */
    expect(beat.tape.endSec - beat.tape.startSec).toBeCloseTo(49.8, 6);
  });

  it("the committed row wins a tie on id in the runtime clock: minted rows go first, disk after", () => {
    /* `runPipeline` builds the runtime pool as `[...minted, ...disk]` so the
       last row under an id — the one `runtimeSecFor` measures — is the
       committed one. A run resumed against a pool that gained the row is timed
       on the cut that will play. */
    const disk = poolRowAt(826.36, 921.04);
    const minted = { ...poolRowAt(826.36, 957.07), source: "generation-tier-2" } as SegmentRecord;
    const items: ForayItem[] = [{ type: "segment", slot: "s", label: "S-1", segment_id: disk.id, role: "explanation" }];
    expect(runtimeSecFor(items, [minted, disk])).toBeCloseTo(921.04 - 826.36, 6);
    expect(runtimeSecFor(items, [disk, minted])).toBeCloseTo(957.07 - 826.36, 6);
  });

  it("an unrelated start still mints: a pool row elsewhere in the same episode is not a collision", () => {
    const elsewhere = poolRowAt(500, 560);
    const result = run([elsewhere]);
    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing !== "tape") return;
    expect(beat.tape.tier).toBe(2);
    expect(beat.tape.segmentId).toBe(`${ITEM_ID}#100`);
    expect(result.newSegments).toHaveLength(1);
    expect(result.newSegments[0]!.id).toBe(`${ITEM_ID}#100`);
    expect(result.tapeRelevance[0]!.poolCut).toBeUndefined();
  });

  it("a pool cut the ledger refuses refuses the candidate (pool-cut) — never minted beside", () => {
    /* Two beats. The first mints a 32 s cut from episode A — short under D2.
       The second's window, in episode B, is cut to 70 s (fine after a short),
       but B's committed row at that start is 39.8 s: a second short in a row,
       which D2 refuses. The answer is `pool-cut` and narration for the beat —
       not a `…#100-2` beside the pool's `…#100`. */
    const episodeB: TranscriptDigestEntry = { ...episode, guid: "pa-173", title: "Episode 173", enclosure_url: "https://cdn.example/pa-173.mp3" };
    const itemB = deriveItemId(episodeB);
    const cuesB: TranscriptCue[] = [
      { text: "welcome back to the show today we are talking about benchmarks", start_sec: 70, end_sec: 100 },
      { text: "the labels in that benchmark were wrong more often than anyone admitted", start_sec: 100, end_sec: 108 },
      { text: "an audit found thousands of mislabelled validation images across the whole benchmark", start_sec: 108, end_sec: 120 },
      { text: "and those wrong labels put a ceiling on the accuracy anyone could report", start_sec: 120, end_sec: 132 },
      { text: "the audit of those mislabelled validation images put a ceiling on the benchmark", start_sec: 132, end_sec: 150 },
      { text: "wrong labels across the whole benchmark and the accuracy anyone could report", start_sec: 150, end_sec: 170 },
      { text: "we will come back to that after the break", start_sec: 170, end_sec: 190 }
    ];
    const committedB = { ...poolRowAt(100.2, 140, `${itemB}#100`), item_id: itemB };
    const acts: DeepenedAct[] = [
      {
        ...seededAct()[0]!,
        slots: [
          {
            title: "Labels",
            beats: [
              { claim, exploration: false, kind: "account", seed: { episodeId: ITEM_ID, startSec: 100, endSec: 132 } },
              { claim, exploration: false, kind: "account", seed: { episodeId: itemB, startSec: 100, endSec: 170 } }
            ]
          }
        ]
      }
    ];
    const cuesByGuid: Record<string, TranscriptCue[]> = { "pa-172": cues, "pa-173": cuesB };
    const result = sourceBeats(acts, {
      segmentPool: [committedB],
      transcriptArchive: [episode, episodeB],
      cueProvider: { getCues: (entry) => cuesByGuid[entry.guid] ?? null },
      textIndex: textIndexOver([episode, episodeB], cuesByGuid),
      topic: TOPIC
    });
    const beats = allSourcedBeats(result.acts);
    expect(beats[0]!.sourcing).toBe("tape");
    expect(beats[1]!.sourcing).toBe("narration");
    expect(result.sourcingTrace).toHaveLength(1);
    expect(result.sourcingTrace[0]!.tier2!.gate).toBe("pool-cut");
    expect(result.newSegments.map((s) => s.id)).toEqual([`${ITEM_ID}#100`]);
    expect(result.newSegments.some((s) => s.id.startsWith(`${itemB}#`))).toBe(false);
  });
});

describe("F-84 at publish — mintedPoolCollisions refuses a row beside a committed one", () => {
  /* The run-6 numbers. */
  const ITEM = "practical-ai--ai-policy-and-the-battle-for-computing-power";
  const onDisk = { id: `${ITEM}#826`, item_id: ITEM, start_sec: 826.36, end_sec: 921.04 };
  const mintedAt = (id: string, startSec: number, endSec: number): NewSegment => ({
    id,
    itemId: ITEM,
    startSec,
    endSec,
    referenceDurationSec: 3000,
    startAnchor: "the fabs in taiwan are the thing that matters",
    endAnchor: "and that is the whole of the chip fight",
    confidence: "medium",
    why: "Taiwan's chip factories carry more weight in this fight than the chips themselves.",
    transcriptSource: "publisher"
  });

  it("refuses the suffixed sibling run 6 minted (#826-2 at 826.36 s beside #826)", () => {
    const errors = mintedPoolCollisions([mintedAt(`${ITEM}#826-2`, 826.36, 957.07)], [onDisk]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/#826-2/);
    expect(errors[0]).toMatch(/not its item_id \+ start_sec/);
    expect(errors[0]).toMatch(/F-84/);
  });

  it("refuses a well-formed id that starts where a committed row of the same episode starts", () => {
    /* 826.8 rounds to 827 — a legal id on its own — but it begins on the same
       cue boundary as #826 within the tolerance. One row per start. */
    const errors = mintedPoolCollisions([mintedAt(`${ITEM}#827`, 826.8, 957.07)], [onDisk]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/starts where committed .*#826/);
  });

  it("refuses a row whose id is on disk but whose cut differs — the publish would skip it and mis-time the Foray", () => {
    const errors = mintedPoolCollisions([mintedAt(`${ITEM}#826`, 826.36, 957.07)], [onDisk]);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/would shadow committed .*#826/);
  });

  it("is not a collision when the minted row IS its on-disk twin (an idempotent re-publish), nor at an unrelated start", () => {
    expect(mintedPoolCollisions([mintedAt(`${ITEM}#826`, 826.36, 921.04)], [onDisk])).toEqual([]);
    expect(mintedPoolCollisions([mintedAt(`${ITEM}#1200`, 1200.1, 1300)], [onDisk])).toEqual([]);
    expect(mintedPoolCollisions([], [onDisk])).toEqual([]);
  });

  it("finalize refuses the collision before the checkers run: buildCandidateFiles throws on a sibling of a fixture row", () => {
    const sibling: NewSegment = {
      id: "boundary-ep-a#200-2",
      itemId: "boundary-ep-a",
      startSec: 200.3,
      endSec: 300,
      referenceDurationSec: 3600,
      startAnchor: "so the first thing we did was",
      endAnchor: "and that is how the pipeline ended up",
      confidence: "medium",
      why: "The first thing the team did was wire the pipeline end to end.",
      transcriptSource: "publisher"
    };
    expect(() => buildCandidateFiles({ id: "f84-test" }, FIXTURE_ROOT, { segments: [sibling], sources: [], topic: "fixture/boundary" })).toThrow(
      /boundary-ep-a#200-2 .*not its item_id \+ start_sec/
    );
    /* And the well-formed-id shape of the same collision. */
    expect(() =>
      buildCandidateFiles({ id: "f84-test" }, FIXTURE_ROOT, { segments: [{ ...sibling, id: "boundary-ep-a#200", startSec: 200.3 }], sources: [], topic: "fixture/boundary" })
    ).toThrow(/would shadow committed boundary-ep-a#200/);
  });
});

describe("F-84 — the one definition of 'the same start'", () => {
  it("half a second, or the same rounded second: the pool's id rule in numbers", () => {
    expect(SEGMENT_START_TOLERANCE_SEC).toBe(0.5);
    expect(startsCoincide(826.36, 826.36)).toBe(true);
    expect(startsCoincide(826.36, 826.8)).toBe(true); // within 0.5
    expect(startsCoincide(825.6, 826.4)).toBe(true); // 0.8 apart, but both are `#826`
    expect(startsCoincide(826.4, 827.6)).toBe(false); // 1.2 apart, #826 vs #828
    expect(startsCoincide(100, 500)).toBe(false);
    const pool = [{ item_id: "a", start_sec: 826.36 }, { item_id: "b", start_sec: 826.36 }];
    expect(segmentAtStart(pool, "a", 826.8)).toBe(pool[0]);
    expect(segmentAtStart(pool, "a", 900)).toBeNull();
    expect(segmentAtStart(pool, "c", 826.36)).toBeNull();
  });
});
