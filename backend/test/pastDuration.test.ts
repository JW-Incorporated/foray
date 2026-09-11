import { describe, it, expect } from "vitest";
import { sourceBeats, type SourceBeatsOptions } from "../src/generation/sourceBeats";
import { mintSegmentSource } from "../src/generation/audioSourceLookup";
import { buildProjectedItems } from "../src/generation/partialProjection";
import { FileTranscriptTextIndex, type TranscriptBodySource, type TranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import { allSourcedBeats } from "../src/types/tapeSourcing";
import type { DeepenedAct } from "../src/types/spine";
import type { TranscriptDigestEntry, TranscriptCue } from "../src/generation/transcriptArchiveLookup";

/**
 * F-87 (#315) — a tape window whose cut would END past the episode's
 * feed-declared duration is refused at sourcing, never clamped.
 *
 * THE FIXTURE IS RUN 7 ATTEMPT 3 (2026-09-11 ~15:20Z, engineering disasters):
 * sourcing minted `causality-engineered-network--1-bp-texas-city#2292` with
 * `end_sec 2375.72` while the digest's `feed_duration_sec` — and so the minted
 * source row's `duration_sec` — was 2071. Every act was narrated (81 calls,
 * acts in parallel per G-32) before `check-forays.mjs` refused act 1's partial
 * ("end_sec 2375.72 is past the episode's 2071 s") and G-30 aborted the run.
 * Causality's *BP Texas City* is the very episode #315 measured: declared
 * 2,071 s, transcript to 3,033 s, `span_implausible` false at a 1.464 ratio.
 *
 * Why refuse rather than cut shorter: a transcript that overruns the audio it
 * describes is a timeline that may be SHIFTED rather than merely longer, and
 * a shorter cut of it would pass the checker and play the wrong words (#315).
 *
 * The candidates reach tier 2 through the real text index over in-memory
 * bodies (the production path, and what run 7 ran) — the episode's real title
 * carries two claim tokens, under the title-only fallback's bar, and that bar
 * is not what is under test here.
 */

const FEED_DURATION_SEC = 2071;
const CUT_END_SEC = 2375.72;
const ITEM_ID = "causality-engineered-network--1-bp-texas-city";

function bpTexasCity(overrides: Partial<TranscriptDigestEntry> = {}): TranscriptDigestEntry {
  return {
    show_id: "causality-engineered-network",
    show_title: "Causality",
    guid: "causality-1",
    title: "1: BP Texas City",
    cues: 7,
    feed_duration_sec: FEED_DURATION_SEC,
    enclosure_url: "https://cdn.example/causality-1.mp3",
    ...overrides
  };
}

/** The stretch run 7 cut: 2292.0 s to 2375.72 s, every cue on the claim. */
const cues: TranscriptCue[] = [
  { text: "at bp texas city the isomerization unit was coming back from a turnaround and the restart began", start_sec: 2292.0, end_sec: 2301.4 },
  { text: "the raffinate splitter tower was overfilled because the level indicator only read the bottom of the tower", start_sec: 2301.4, end_sec: 2312.1 },
  { text: "so the operators kept feeding raffinate into a splitter tower that was already full to the top", start_sec: 2312.1, end_sec: 2323.9 },
  { text: "the relief valves lifted and sent the liquid to a blowdown drum that vented straight to the atmosphere", start_sec: 2323.9, end_sec: 2336.3 },
  { text: "there was no flare on that blowdown drum so hydrocarbon vapour just poured out over the ground", start_sec: 2336.3, end_sec: 2349.0 },
  { text: "a geyser of hydrocarbon from the atmospheric vent stack and then the trailers full of contractors", start_sec: 2349.0, end_sec: 2362.5 },
  { text: "that is the bp texas city restart in a sentence a tower overfilled a drum vented to atmosphere and no flare", start_sec: 2362.5, end_sec: CUT_END_SEC }
];

const claim =
  "At BP Texas City the raffinate splitter tower was overfilled during the restart and the blowdown drum vented hydrocarbon straight to the atmosphere with no flare.";

function acts(): DeepenedAct[] {
  return [
    {
      title: "Act 1",
      thesis: "Shortcuts that passed their tests.",
      startState: "The listener has heard of Texas City.",
      endState: "The listener knows how the tower overfilled.",
      slots: [{ title: "The restart", beats: [{ claim, exploration: false }] }],
      introduction: "Intro",
      exit: "Exit"
    }
  ];
}

/** The same index production ranks candidates with, over bodies held in
 * memory — every fixture episode speaks the same cues. */
function memoryTextIndex(archive: TranscriptDigestEntry[]): TranscriptTextIndex {
  const bodies: TranscriptBodySource = {
    getCues: () => cues,
    bodyStat: () => ({ mtimeMs: 1, size: 1 })
  };
  return new FileTranscriptTextIndex({ archive, bodies, cache: false });
}

const audioSourceFor: NonNullable<SourceBeatsOptions["audioSourceFor"]> = (entry, itemId) =>
  mintSegmentSource(
    entry,
    itemId,
    new Map([["causality-engineered-network", { dai: false, feedUrl: "https://example.invalid/causality.xml", appleCollectionId: null }]])
  );

function source(archive: TranscriptDigestEntry[], overrides: Partial<SourceBeatsOptions> = {}) {
  return sourceBeats(acts(), {
    segmentPool: [],
    transcriptArchive: archive,
    cueProvider: { getCues: () => cues },
    textIndex: memoryTextIndex(archive),
    audioSourceFor,
    ...overrides
  });
}

describe("sourceBeats — F-87: a cut past the episode's declared duration is refused, not clamped (#315)", () => {
  it("refuses run 7's window with gate `past-duration`, and the trace carries both numbers (2375.72 vs 2071)", () => {
    /* MUTATION THAT KILLS THIS: drop `pastDurationGate` from `placementGateFor`
       (or clamp the span to the duration). The segment mints, the beat is tape,
       and the trace has no row. Ran it — red. */
    const result = source([bpTexasCity()]);
    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("narration");
    expect(result.newSegments).toHaveLength(0);
    /* No source row either: the refusal is asked BEFORE the audio row is
       minted, so a refused episode leaves nothing in segment-sources. */
    expect(result.newSegmentSources).toHaveLength(0);

    const trace = result.sourcingTrace[0]!.tier2!;
    expect(trace.gate).toBe("past-duration");
    expect(trace.bestEpisodeTitle).toBe("1: BP Texas City");
    expect(trace.spanEndSec).toBe(CUT_END_SEC);
    expect(trace.feedDurationSec).toBe(FEED_DURATION_SEC);
    expect(trace.spanEndSec!).toBeGreaterThan(trace.feedDurationSec!);
    /* The narration reason names the rule, so §4.7's writer is not told "no
       tape found" about tape that exists. */
    expect(beat.sourcing === "narration" && beat.narration.reason).toMatch(/runs past the length the episode's feed declares/);
  });

  it("still mints the same window when the cut ends inside the declared duration", () => {
    /* MUTATION THAT KILLS THIS: compare with `>=` on the duration, or refuse
       whenever a duration is declared at all. The control: the identical tape
       on a feed that declares 2400 s is cut and minted exactly as before F-87. */
    const result = source([bpTexasCity({ feed_duration_sec: 2400 })]);
    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    expect(result.newSegments).toHaveLength(1);
    expect(result.newSegments[0]!.id).toBe(`${ITEM_ID}#2292`);
    expect(result.newSegments[0]!.endSec).toBe(CUT_END_SEC);
    expect(result.newSegments[0]!.referenceDurationSec).toBe(2400);
    expect(result.newSegmentSources[0]!.duration_sec).toBe(2400);
    expect(result.sourcingTrace).toHaveLength(0);
  });

  it("falls through to the next candidate episode rather than to narration when another episode can carry the claim", () => {
    /* MUTATION THAT KILLS THIS: make `past-duration` end the walk (return
       instead of `continue` in `Tier2Walk.run`). The beat would be narrated
       although a second episode's tape was inside its duration. */
    const overrunning = bpTexasCity();
    const honest = bpTexasCity({ guid: "causality-1b", title: "1b: BP Texas City revisited", feed_duration_sec: 2400 });
    const result = source([overrunning, honest]);
    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    expect(beat.sourcing === "tape" && beat.tape.itemId).toBe("causality-engineered-network--1b-bp-texas-city-revisited");
    expect(result.newSegments.map((s) => s.itemId)).toEqual(["causality-engineered-network--1b-bp-texas-city-revisited"]);
    /* And the refused episode left no source row behind. */
    expect(result.newSegmentSources.map((s) => s.id)).toEqual(["causality-engineered-network--1b-bp-texas-city-revisited"]);
  });

  it("is inert when the digest declares no duration — there is nothing to compare against", () => {
    /* MUTATION THAT KILLS THIS: treat a missing `feed_duration_sec` as 0. The
       gate has no number to argue with, so it does not fire; the audio-source
       row is what refuses an undurationed episode when a resolver is present
       (`mintSegmentSource` needs `duration_sec > 0`), and with none supplied
       the segment mints exactly as every pre-F-87 caller expects. */
    const undeclared = bpTexasCity();
    delete undeclared.feed_duration_sec;
    const result = source([undeclared], { audioSourceFor: undefined });
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("tape");
    expect(result.newSegments[0]!.referenceDurationSec).toBe(CUT_END_SEC);
  });

  it("logs a transcription-queue row that names both numbers and #315 — a local transcription would settle the timeline", () => {
    /* MUTATION THAT KILLS THIS: let `past-duration` fall to the default queue
       row ("logged for future transcription…" with no episode), or to the
       assembly-rules row ("Nothing to transcribe"), which is the opposite of
       the truth here. */
    const result = source([bpTexasCity()]);
    expect(result.transcriptionQueueCandidates).toHaveLength(1);
    const row = result.transcriptionQueueCandidates[0]!;
    expect(row.showId).toBe("causality-engineered-network");
    expect(row.reason).toContain(`${CUT_END_SEC} s`);
    expect(row.reason).toContain(`${FEED_DURATION_SEC} s`);
    expect(row.reason).toContain("#315");
    expect(row.reason).not.toMatch(/Nothing to transcribe/);
  });
});

describe("partial projection — F-87: a partial can no longer carry a segment past its episode's duration", () => {
  /* The projection (#620) and the per-act partial read sourcing's beats as
     given; they inherit the rule by construction. Pinned here so a future
     "clamp at projection time" cannot quietly reintroduce the run-7 partial:
     `actIndex: -1` projects the whole Foray from sourcing's plan, which is
     exactly what act 0's partial is judged against. */
  it("projects a narration item, not the run-7 segment, for the refused beat", () => {
    /* MUTATION THAT KILLS THIS: the same one as above — drop
       `pastDurationGate` — because the projection has no rule of its own to
       mutate; it carries whatever sourcing placed. Ran it — red here too, the
       run-7 segment projected. */
    const result = source([bpTexasCity()]);
    const projected = buildProjectedItems([], -1, { sourcedActs: result.acts, slots: [] });
    expect(projected.projectedTapeSegments).toBe(0);
    expect(projected.items.filter((i) => i.type === "segment")).toEqual([]);
    expect(projected.items.some((i) => i.type === "segment" && i.segment_id === `${ITEM_ID}#2292`)).toBe(false);
    expect(projected.projectedNarrationItems).toBe(1);
  });

  it("projects the segment when the same window ends inside the declared duration", () => {
    const result = source([bpTexasCity({ feed_duration_sec: 2400 })]);
    const projected = buildProjectedItems([], -1, { sourcedActs: result.acts, slots: [] });
    expect(projected.projectedTapeSegments).toBe(1);
    expect(projected.items.filter((i) => i.type === "segment").map((i) => i.type === "segment" && i.segment_id)).toEqual([`${ITEM_ID}#2292`]);
    expect(projected.addedRuntimeSec).toBeCloseTo(CUT_END_SEC - 2292.0, 2);
  });
});
