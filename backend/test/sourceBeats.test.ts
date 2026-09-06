import { describe, it, expect } from "vitest";
import { sourceBeats, M4_ITEM_SHARE_MAX } from "../src/generation/sourceBeats";
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

/* THE THREE FORAY-WIDE ASSEMBLY RULES, added after the first end-to-end run of
   the pipeline (`runPipeline.ts`) failed `check-forays.mjs` on all three of its
   prompts. Per-beat sourcing was stateless, so nothing stopped it building a
   Foray the checker would certainly reject. Each rule below names the exact
   checker error it exists to prevent. */
describe("sourceBeats — Foray-wide assembly constraints", () => {
  /** Several segments from two episodes, spaced so every rule can be exercised. */
  function multiPool(): SegmentRecord[] {
    const base = {
      topic: "engineering/energy-fusion",
      reference_duration_sec: 11840,
      why: "Whyte explains the Lawson criterion tokamak plasma confinement without hand-waving",
      confidence: "high" as const,
      transcript_source: "publisher",
      dai_suspected: false,
      source: "agent-v1",
      batch_id: "seg-test",
      needs_review: false
    };
    const seg = (id: string, item: string, start: number) => ({
      ...base,
      id,
      item_id: item,
      start_sec: start,
      end_sec: start + 120,
      start_anchor: "so the lawson criterion is really a statement about",
      end_anchor: "and that's why the tokamak won by default for thirty years"
    });
    /* ep-a is listed LATEST-FIRST on purpose. Every beat in these tests makes
       the same claim, so every segment scores the same and the ranked walk
       falls back to pool order — which means an unguarded matcher would place
       ep-a at 1800 s, then 900 s, then 100 s, i.e. descending, which is exactly
       the M3 violation. An ascending fixture would let the ordering test pass
       with the guard deleted. */
    return [
      seg("ep-a#1800", "ep-a", 1800),
      seg("ep-a#900", "ep-a", 900),
      seg("ep-a#100", "ep-a", 100),
      seg("ep-b#1200", "ep-b", 1200),
      seg("ep-b#200", "ep-b", 200)
    ] as SegmentRecord[];
  }

  /* ASCENDING, and with six segments in one episode. The descending pool above
     is right for the ordering test and wrong for the other two: with segments
     listed latest-first the M3 guard admits only the first from each episode,
     so no episode can ever reach the M4 cap and no beat can ever collide with a
     used id. Both of those tests then passed with their own clause deleted —
     they were pinning M3. This fixture leaves room for six picks from `ep-a`,
     so the cap (3 of 12 beats) genuinely binds and dedupe genuinely matters. */
  function ascendingPool(): SegmentRecord[] {
    const base = multiPool()[0]!;
    const seg = (item: string, start: number) =>
      ({ ...base, id: `${item}#${start}`, item_id: item, start_sec: start, end_sec: start + 120 }) as SegmentRecord;
    return [
      seg("ep-a", 100), seg("ep-a", 400), seg("ep-a", 700),
      seg("ep-a", 1000), seg("ep-a", 1300), seg("ep-a", 1600),
      seg("ep-b", 200), seg("ep-b", 500)
    ];
  }

  /** N beats all making the SAME claim — the worst case for a stateless matcher. */
  function identicalClaimActs(n: number): DeepenedAct[] {
    const claim = "The Lawson criterion is a statement about tokamak plasma confinement.";
    return [
      makeDeepenedAct({
        slots: [{ title: "Fusion basics", beats: Array.from({ length: n }, () => ({ claim, exploration: false })) }]
      })
    ];
  }

  function tapePointers(result: ReturnType<typeof sourceBeats>) {
    return allSourcedBeats(result.acts)
      .filter((b) => b.sourcing === "tape")
      .map((b) => b.tape!);
  }

  it("never plays the same segment twice in one Foray", () => {
    /* CHECKER ERROR THIS PREVENTS: 'segment "X" appears twice in one Foray'.
       Every beat here makes an identical claim, so a stateless matcher returns
       the same top-scoring segment every time.

       MUTATION THAT KILLS THIS: drop the `usedSegmentIds.has(...)` clause from
       the isUsable predicate in resolveOneBeat. Ran it — red. */
    /* TWELVE beats, not four. The M4 cap allows floor(12 * 0.25) = 3 segments
       per episode; at four beats the cap alone held every episode to one, so
       this test passed with the dedupe clause DELETED — it was pinning M4, not
       dedupe. Measured: with the clause removed and twelve beats, the same
       segment id is returned three times. */
    const result = sourceBeats(identicalClaimActs(12), { segmentPool: ascendingPool(), transcriptArchive: [] });
    const ids = tapePointers(result).map((t) => t.segmentId);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("plays segments from one episode in ascending time order", () => {
    /* CHECKER ERROR THIS PREVENTS: M3, "plays at 1964.16 s ... after a later
       segment from the same episode". A Foray that jumps backwards inside one
       episode reads as a mistake to a listener.

       MUTATION THAT KILLS THIS: drop the `segment.start_sec >= lastStart`
       clause. The pool is ordered so the matcher would otherwise be free to
       pick an earlier start after a later one. Ran it — red. */
    /* Twelve beats for the same reason as the dedupe case: at five, the M4 cap
       held each episode to one segment and there was no order to get wrong, so
       this passed with the ordering clause deleted. */
    const result = sourceBeats(identicalClaimActs(12), { segmentPool: multiPool(), transcriptArchive: [] });
    const byItem = new Map<string, number[]>();
    for (const t of tapePointers(result)) {
      if (!byItem.has(t.itemId)) byItem.set(t.itemId, []);
      byItem.get(t.itemId)!.push(t.startSec);
    }
    for (const [item, starts] of byItem) {
      expect(starts, `episode ${item} plays out of order: ${starts.join(", ")}`)
        .toEqual([...starts].sort((a, b) => a - b));
    }
  });

  it("holds any one episode under the M4 share cap", () => {
    /* CHECKER ERROR THIS PREVENTS: 'M4 FAIL: "X" is 33.3 % of segments ...
       over the 25 % cap'. Sourcing can only bound the COUNT — runtime share is
       not known until stitching — and the count is what was failing.

       MUTATION THAT KILLS THIS: drop the `usedCountByItem >= maxPerItem`
       clause. With every beat making the same claim, one episode takes them
       all. Ran it — red. */
    const acts = identicalClaimActs(12);
    const result = sourceBeats(acts, { segmentPool: ascendingPool(), transcriptArchive: [] });
    const pointers = tapePointers(result);
    const counts = new Map<string, number>();
    for (const t of pointers) counts.set(t.itemId, (counts.get(t.itemId) ?? 0) + 1);
    const cap = Math.max(1, Math.floor(12 * M4_ITEM_SHARE_MAX));
    for (const [item, n] of counts) {
      expect(n, `episode ${item} supplied ${n} of ${pointers.length} tape beats (cap ${cap})`).toBeLessThanOrEqual(cap);
    }
    expect(pointers.length, "the cap must bind before the pool runs out, or this pins nothing").toBeGreaterThan(cap);
  });

  it("degrades a beat to narration rather than breaking a rule to keep tape", () => {
    /* §4.5's guardrail: a beat's existence never depends on tape. With one
       segment and three identical claims, two beats must become narration — the
       constraints must not be satisfied by inventing or reusing tape.

       MUTATION THAT KILLS THIS: make the isUsable predicate return true
       unconditionally; all three beats take the single segment. Ran it — red. */
    const pool = [multiPool()[0]!];
    const result = sourceBeats(identicalClaimActs(3), { segmentPool: pool, transcriptArchive: [] });
    const beats = allSourcedBeats(result.acts);
    expect(beats).toHaveLength(3);
    expect(beats.filter((b) => b.sourcing === "tape")).toHaveLength(1);
    expect(beats.filter((b) => b.sourcing === "narration")).toHaveLength(2);
  });
});
