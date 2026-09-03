import { describe, it, expect } from "vitest";
import { sourceBeats } from "../src/generation/sourceBeats";
import { validateSourcing, allSourcedBeats } from "../src/types/tapeSourcing";
import type { DeepenedAct } from "../src/types/spine";
import type { SegmentRecord } from "../src/generation/segmentPoolLookup";
import type { TranscriptDigestEntry, TranscriptCue, TranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import { loadSegmentPool } from "../src/generation/segmentPoolLookup";

function makeDeepenedAct(overrides: Partial<DeepenedAct> = {}, label = "A"): DeepenedAct {
  return {
    title: `Act ${label}`,
    thesis: `Act ${label} establishes something new.`,
    startState: `The listener does not yet know about ${label}.`,
    endState: `The listener now understands ${label}.`,
    slots: [
      {
        title: `${label} slot 1`,
        beats: [
          { claim: `Researchers documented ${label} extensively in the 1990s.`, exploration: false },
          { claim: `${label} changed rapidly after a key discovery.`, exploration: true }
        ]
      }
    ],
    introduction: `Intro for ${label}`,
    exit: `Exit for ${label}`,
    ...overrides
  };
}

function fixtureSegmentPool(): SegmentRecord[] {
  return [
    {
      id: "lex-353-whyte#2530",
      item_id: "lex-353-whyte",
      topic: "engineering/energy-fusion",
      start_sec: 2530,
      end_sec: 3110,
      reference_duration_sec: 11840,
      start_anchor: "so the lawson criterion is really a statement about",
      end_anchor: "and that's why the tokamak won by default for thirty years",
      why: "Whyte explains the Lawson criterion tokamak plasma confinement without hand-waving",
      confidence: "high",
      transcript_source: "publisher",
      dai_suspected: false,
      source: "agent-v1",
      batch_id: "seg-test",
      needs_review: false
    }
  ];
}

describe("sourceBeats — tier 1: existing data/segments.json hit, no new segment created", () => {
  it("resolves a beat whose claim closely matches an existing segment to tier 1", () => {
    const pool = fixtureSegmentPool();
    const spine: DeepenedAct[] = [
      makeDeepenedAct(
        {
          slots: [
            {
              title: "Fusion basics",
              beats: [{ claim: "Whyte explains the Lawson criterion for tokamak plasma confinement clearly.", exploration: false }]
            }
          ]
        },
        "Fusion"
      )
    ];

    const result = sourceBeats(spine, { segmentPool: pool, transcriptArchive: [] });

    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing === "tape") {
      expect(beat.tape.tier).toBe(1);
      expect(beat.tape.segmentId).toBe("lex-353-whyte#2530");
      expect(beat.tape.itemId).toBe("lex-353-whyte");
      expect(beat.tape.startAnchor).toBe(pool[0]!.start_anchor);
    }
    // Tier 1 never mints a new segment.
    expect(result.newSegments).toHaveLength(0);
  });

  it("resolves against the REAL data/segments.json pool for a claim built from a real segment's own why-line", () => {
    const realPool = loadSegmentPool();
    expect(realPool.length).toBeGreaterThan(0);
    const target = realPool[0]!;
    // Build a claim that echoes the real segment's own topic + why text,
    // simulating a spine beat whose claim was written from that same tape.
    const claim = `${target.why}. This connects directly to ${target.topic.replace("/", " ")}.`;

    const spine: DeepenedAct[] = [makeDeepenedAct({ slots: [{ title: "Real pool slot", beats: [{ claim, exploration: false }] }] }, "Real")];
    const result = sourceBeats(spine, { transcriptArchive: [] });

    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing === "tape") {
      expect(beat.tape.tier).toBe(1);
    }
    expect(result.newSegments).toHaveLength(0);
  });
});

describe("sourceBeats — tier 2: transcript-archive hit produces a NEW segment with real anchors", () => {
  function fixtureArchiveEntry(): TranscriptDigestEntry {
    return {
      show_id: "geology-bites",
      show_title: "Geology Bites",
      guid: "geo-ep-42",
      title: "How volcanic ash layers date the Roman eruption record",
      cues: 3,
      feed_duration_sec: 3600,
      span_implausible: false
    };
  }

  function fixtureCueProvider(): TranscriptCueProvider {
    const cues: TranscriptCue[] = [
      { text: "Today we discuss how volcanic ash layers", start_sec: 100, end_sec: 105 },
      { text: "date the Roman eruption record precisely using", start_sec: 105, end_sec: 111 },
      { text: "radiometric methods developed over decades of fieldwork", start_sec: 111, end_sec: 118 }
    ];
    return { getCues: () => cues };
  }

  it("produces a new segment with real (verbatim, non-timestamp) anchors for a transcript-archive hit", () => {
    const spine: DeepenedAct[] = [
      makeDeepenedAct(
        {
          slots: [
            {
              title: "Volcanic dating",
              beats: [
                {
                  claim: "Volcanic ash layers date the Roman eruption record precisely using radiometric methods.",
                  exploration: false
                }
              ]
            }
          ]
        },
        "Volcano"
      )
    ];

    const result = sourceBeats(spine, {
      segmentPool: [],
      transcriptArchive: [fixtureArchiveEntry()],
      cueProvider: fixtureCueProvider()
    });

    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing === "tape") {
      expect(beat.tape.tier).toBe(2);
      // The anchor must be real, verbatim transcript text, not a raw timestamp.
      expect(beat.tape.startAnchor).toMatch(/[a-z]/);
      expect(Number.isNaN(Number(beat.tape.startAnchor))).toBe(true);
      expect(typeof beat.tape.startSec).toBe("number");
    }
    expect(result.newSegments).toHaveLength(1);
    expect(result.newSegments[0]!.startAnchor).not.toMatch(/^\d+(\.\d+)?$/);
    expect(result.newSegments[0]!.itemId).toBe("geology-bites--how-volcanic-ash-layers-date-the-roman-eruption-record");
  });
});

describe("sourceBeats — tier 3: no transcript anywhere logs a transcription-queue candidate and assigns narration", () => {
  it("logs a candidate and assigns Carry mode when the slot has no tape-sourced beats at all", () => {
    const spine: DeepenedAct[] = [
      makeDeepenedAct(
        {
          slots: [
            {
              title: "Untaped slot",
              beats: [{ claim: "Something entirely unmatched by any catalogue or transcript exists here.", exploration: false }]
            }
          ]
        },
        "Untaped"
      )
    ];

    const result = sourceBeats(spine, { segmentPool: [], transcriptArchive: [] });

    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("narration");
    if (beat.sourcing === "narration") {
      expect(beat.narration.mode).toBe("Carry");
    }
    expect(result.transcriptionQueueCandidates).toHaveLength(1);
    expect(result.transcriptionQueueCandidates[0]!.claim).toContain("unmatched");
  });

  it("assigns Patch mode when the slot has at least one other tape-sourced beat", () => {
    const pool = fixtureSegmentPool();
    const spine: DeepenedAct[] = [
      makeDeepenedAct(
        {
          slots: [
            {
              title: "Mixed slot",
              beats: [
                { claim: "Whyte explains the Lawson criterion for tokamak plasma confinement clearly.", exploration: false },
                { claim: "Something entirely unmatched by any catalogue or transcript exists in this slot.", exploration: false }
              ]
            }
          ]
        },
        "Mixed"
      )
    ];

    const result = sourceBeats(spine, { segmentPool: pool, transcriptArchive: [] });
    const beats = allSourcedBeats(result.acts);
    expect(beats[0]!.sourcing).toBe("tape");
    expect(beats[1]!.sourcing).toBe("narration");
    if (beats[1]!.sourcing === "narration") {
      expect(beats[1]!.narration.mode).toBe("Patch");
    }
  });
});

describe("sourceBeats — §4.5's guardrail: tape presence never changes which beats exist", () => {
  it("beat list going IN equals beat list coming OUT — same count, same claims, only sourcing differs", () => {
    const pool = fixtureSegmentPool();
    const spine: DeepenedAct[] = [
      makeDeepenedAct(
        {
          slots: [
            {
              title: "Mixed slot",
              beats: [
                { claim: "Whyte explains the Lawson criterion for tokamak plasma confinement clearly.", exploration: false },
                { claim: "Something entirely unmatched by any catalogue or transcript exists in this slot.", exploration: true },
                { claim: "A third beat with no tape anywhere rounds out this slot nicely.", exploration: false }
              ]
            }
          ]
        },
        "GuardrailA"
      ),
      makeDeepenedAct({}, "GuardrailB")
    ];

    const result = sourceBeats(spine, { segmentPool: pool, transcriptArchive: [] });

    const inputBeats = spine.flatMap((act) => act.slots.flatMap((slot) => slot.beats));
    const outputBeats = allSourcedBeats(result.acts);

    expect(outputBeats).toHaveLength(inputBeats.length);
    outputBeats.forEach((b, i) => {
      expect(b.claim).toBe(inputBeats[i]!.claim);
      expect(b.exploration).toBe(inputBeats[i]!.exploration);
    });

    const validation = validateSourcing(spine, result.acts);
    expect(validation.valid).toBe(true);
    expect(validation.issues).toEqual([]);
  });

  it("validateSourcing catches a beat-count mismatch (structural regression guard)", () => {
    const spine: DeepenedAct[] = [makeDeepenedAct({}, "X")];
    const tampered = sourceBeats(spine, { segmentPool: [], transcriptArchive: [] }).acts;
    // Simulate a regression that drops a beat.
    const brokenActs = [{ ...tampered[0]!, slots: [{ ...tampered[0]!.slots[0]!, beats: [tampered[0]!.slots[0]!.beats[0]!] }] }];

    const validation = validateSourcing(spine, brokenActs);
    expect(validation.valid).toBe(false);
    expect(validation.issues.some((i) => i.code === "beat-count-changed")).toBe(true);
  });
});

describe("sourceBeats — no audio bytes fetched or written anywhere in this module (structural check)", () => {
  it("has no fetch/http/download call sites in sourceBeats.ts, segmentPoolLookup.ts, or transcriptArchiveLookup.ts", async () => {
    const fs = await import("fs");
    const path = await import("path");
    const files = [
      path.resolve(__dirname, "../src/generation/sourceBeats.ts"),
      path.resolve(__dirname, "../src/generation/segmentPoolLookup.ts"),
      path.resolve(__dirname, "../src/generation/transcriptArchiveLookup.ts")
    ];
    for (const file of files) {
      const source = fs.readFileSync(file, "utf8");
      expect(source).not.toMatch(/\bfetch\s*\(/);
      expect(source).not.toMatch(/require\(["']https?["']\)/);
      expect(source).not.toMatch(/require\(["']node:https?["']\)/);
      expect(source).not.toMatch(/\baxios\b/);
      expect(source).not.toMatch(/\bdownload\w*\s*\(/i);
      expect(source).not.toMatch(/writeFileSync\s*\(\s*.*data-local/);
    }
  });
});
