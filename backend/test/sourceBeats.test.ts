import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { sourceBeats, summarizeSourcing, deriveItemId, M4_ITEM_SHARE_MAX, m4SegmentCapFor } from "../src/generation/sourceBeats";
import { capArgumentBeats, deepenActs } from "../src/generation/deepenActs";
import { buildResearchShape } from "../src/generation/researchShape";
import { buildSpine } from "../src/generation/buildSpine";
import { resolveTopic } from "../src/generation/resolveTopic";
import { StubSpineBuilder } from "../src/generation/StubSpineBuilder";
import { StubDeepenActBuilder } from "../src/generation/StubDeepenActBuilder";
import { StubExternalResearcher } from "../src/generation/StubExternalResearcher";
import { InMemoryCostEventSink } from "../src/cost/costEvents";
import { BudgetGuard } from "../src/cost/budgetGuard";
import type { IntentUnderstanding } from "../src/types/generation";
import { mintSegmentSource } from "../src/generation/audioSourceLookup";
import { validateSourcing, allSourcedBeats } from "../src/types/tapeSourcing";
import { SPINE_MIN_SEEDED_BEATS_PER_ACT, type DeepenedAct } from "../src/types/spine";
import type { SegmentRecord } from "../src/generation/segmentPoolLookup";
import type { TranscriptDigestEntry, TranscriptCue, TranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import {
  ABSOLUTE_MIN_TAPE_SEGMENT_SEC,
  MAX_TAPE_SEGMENT_SEC,
  MIN_TAPE_SEGMENT_SEC,
  TIER2_WINDOW_MIN_SHARE,
  TIER2_WINDOW_MIN_TERMS,
  canonicalizeForAnchorMatch,
  cutWindowToSegment,
  seedFloorDecided,
  selectTapeWindow,
  tapeWindowIsRelevant,
  type TapeWindow
} from "../src/generation/transcriptArchiveLookup";
import { FileTranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import { FileTranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import type { TranscriptBodySource, TranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import { loadSegmentPool } from "../src/generation/segmentPoolLookup";
import { loadTranscriptArchive } from "../src/generation/transcriptArchiveLookup";
import { RawVttCueProvider } from "./helpers/rawVttCueProvider";
import { tokenizeForSourcing } from "../src/generation/catalogueLookup";

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
      path.resolve(__dirname, "../src/generation/transcriptArchiveLookup.ts"),
      // The topic gate's catalogue reader, added with WS-C: it reads committed
      // `data/` files and must be held to the same rule as the rest.
      path.resolve(__dirname, "../src/generation/taxonomyFamily.ts"),
      /* Tier 2's text index, added with WS-H. It is the one module here that
         WRITES — its own inverted index, under
         `data-local/transcripts/index/` — and everything it writes is derived
         from cue TEXT a provider handed it. No audio, no network, and no read
         of `data-local/` that does not go through the cue provider. */
      path.resolve(__dirname, "../src/generation/transcriptTextIndex.ts")
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
    /* SIX MORE EPISODES, ONE SEGMENT EACH, AFTER THE TWO THAT MATTER (F-70).
       They are filler with a job: M4's cap is now measured against the tape
       this Foray has PLACED (`m4SegmentCapFor`), so no episode may supply a
       SECOND segment until the Foray holds eight, and with only ep-a and ep-b
       in the pool every episode would be held to one — which would make the
       ordering test below pass with the M3 clause deleted, because there would
       never be two segments from one episode to get the order wrong. These
       eight fill the Foray to the point where ep-a is asked a second time. */
    const filler = ["ep-c", "ep-d", "ep-e", "ep-f", "ep-g", "ep-h"].map((item, i) => seg(`${item}#${300 + i}`, item, 300 + i));
    return [
      seg("ep-a#1800", "ep-a", 1800),
      seg("ep-a#900", "ep-a", 900),
      seg("ep-a#100", "ep-a", 100),
      seg("ep-b#1200", "ep-b", 1200),
      seg("ep-b#200", "ep-b", 200),
      ...filler
    ] as SegmentRecord[];
  }

  /* ASCENDING, and with six segments in one episode. The descending pool above
     is right for the ordering test and wrong for the other two: with segments
     listed latest-first the M3 guard admits only the first from each episode,
     so no episode can ever reach the M4 cap and no beat can ever collide with a
     used id. Both of those tests then passed with their own clause deleted —
     they were pinning M3. This fixture leaves room for six picks from `ep-a`,
     so the cap genuinely binds and dedupe genuinely matters.

     SIX SINGLE-SEGMENT EPISODES AT THE END, for the same reason `multiPool`
     grew them (F-70): the cap is now a share of the PLACED tape, so ep-a is
     not asked for a second segment until the Foray holds eight — and until it
     is asked, neither the cap nor the dedupe clause has anything to refuse. */
  function ascendingPool(): SegmentRecord[] {
    const base = multiPool()[0]!;
    const seg = (item: string, start: number) =>
      ({ ...base, id: `${item}#${start}`, item_id: item, start_sec: start, end_sec: start + 120 }) as SegmentRecord;
    return [
      seg("ep-a", 100), seg("ep-a", 400), seg("ep-a", 700),
      seg("ep-a", 1000), seg("ep-a", 1300), seg("ep-a", 1600),
      seg("ep-b", 200), seg("ep-b", 500),
      seg("ep-c", 300), seg("ep-d", 300), seg("ep-e", 300),
      seg("ep-f", 300), seg("ep-g", 300), seg("ep-h", 300)
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
    /* TWELVE beats, not four, and a pool of eight episodes. At four beats the
       M4 cap alone held every episode to one segment, so this test passed with
       the dedupe clause DELETED — it was pinning M4, not dedupe. Under F-70's
       cap the same trap moved rather than closing: an episode is not asked for
       a second segment until the Foray holds eight, so a two-episode pool would
       be just as vacuous. Twelve beats over eight episodes gets ep-a asked
       again, and with the dedupe clause removed it hands back ep-a#100 — the
       segment it already played — a second time. */
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
    /* Twelve beats over eight episodes, for the same reason as the dedupe case:
       while the M4 cap holds each episode to one segment there is no order to
       get wrong, and this passes with the ordering clause deleted. Once the
       Foray holds eight segments ep-a is asked again, and the pool offers it
       900 s after 1800 s has already played. */
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

  it("holds any one episode under the M4 share cap, measured against the tape actually placed", () => {
    /* CHECKER ERROR THIS PREVENTS: 'M4 FAIL: "X" is 33.3 % of segments ...
       over the 25 % cap'. Sourcing can only bound the COUNT — runtime share is
       not known until stitching — and the count is what was failing.

       THE DENOMINATOR IS THE PLACED TAPE COUNT, NOT THE BEAT COUNT (F-70). The
       cap used to be `floor(totalBeats * 0.25)` fixed up front, which in run 2
       attempt 4b read 6 for a Foray that ended up with 5 tape segments — a cap
       that cannot bind. It is now a share of what has been placed, so this test
       measures the same ratio `check-forays.mjs` measures.

       MUTATION THAT KILLS THIS: drop the `m4ShareAllows` clause from
       `tier1VetoFor`. With every beat making the same claim, ep-a takes six of
       the twelve. Ran it — red. */
    const acts = identicalClaimActs(12);
    const result = sourceBeats(acts, { segmentPool: ascendingPool(), transcriptArchive: [] });
    const pointers = tapePointers(result);
    const counts = new Map<string, number>();
    for (const t of pointers) counts.set(t.itemId, (counts.get(t.itemId) ?? 0) + 1);
    const cap = m4SegmentCapFor(pointers.length);
    for (const [item, n] of counts) {
      expect(n, `episode ${item} supplied ${n} of ${pointers.length} tape beats (cap ${cap})`).toBeLessThanOrEqual(cap);
      /* And the same statement the checker would make, in the checker's own
         terms — no episode over a quarter of the segments. */
      expect(n / pointers.length, `episode ${item} is ${((n / pointers.length) * 100).toFixed(1)} % of the segments`).toBeLessThanOrEqual(
        M4_ITEM_SHARE_MAX
      );
    }
    /* The cap must BIND, or this pins nothing: ep-a offers six segments to
       twelve identical claims and must not have supplied them all. */
    expect(pointers.length).toBeGreaterThan(cap);
    expect(counts.get("ep-a")).toBeLessThan(6);
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

describe("sourceBeats — generation run 1 (2026-09-09) regressions: cross-domain false positives", () => {
  // Beat 4 of run 1: the Kansas City code-load claim was tier-1-matched to a
  // British hearth-cooking segment on the shared tokens `have, one, people,
  // would`. Function words are not evidence of a shared subject.
  const kansasCityClaim =
    "The original, unrevised design was already carrying roughly half the load required by the Kansas City building code, so a full structural review — had one occurred — would likely have found the walkway inadequate even without the phone-call revision, meaning the design was failing before the failure that killed people.";

  function griddleSegment(): SegmentRecord {
    return {
      id: "bfh-griddle-bakestone#740",
      item_id: "bfh-griddle-bakestone",
      topic: "food/food-history",
      start_sec: 739.88,
      end_sec: 865.1,
      reference_duration_sec: 2764.45,
      start_anchor: "I tossed a few things over a fire, not a historic reenactment with my girdle",
      end_anchor: "the utility has been preserved because it's so it's still tied to our current food culture",
      why: "Most British cooking happened at an open hearth until the mid-19th century, with no home oven. People would have had one hearth.",
      confidence: "medium",
      transcript_source: "asr-local",
      dai_suspected: false,
      source: "agent-v1",
      batch_id: "seg-2026-08-16-bfh-hearth-a",
      needs_review: false
    };
  }

  it("does not anchor an engineering claim to a food-history segment that shares only function words", () => {
    const spine: DeepenedAct[] = [
      makeDeepenedAct({ slots: [{ title: "Hyatt", beats: [{ claim: kansasCityClaim, exploration: true }] }] })
    ];
    const result = sourceBeats(spine, { segmentPool: [griddleSegment()], transcriptArchive: [], cueProvider: { getCues: () => null } });
    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("narration");
  });

  it("against the REAL pool, a Kansas City walkway claim lands on the Hyatt Regency segment or on nothing — never on another topic", () => {
    const spine: DeepenedAct[] = [
      makeDeepenedAct({ slots: [{ title: "Hyatt", beats: [{ claim: kansasCityClaim, exploration: true }] }] })
    ];
    const result = sourceBeats(spine, { segmentPool: loadSegmentPool(), transcriptArchive: [], cueProvider: { getCues: () => null } });
    const beat = allSourcedBeats(result.acts)[0]!;
    if (beat.sourcing === "tape") {
      expect(beat.tape.itemId).toMatch(/hyatt/);
    }
  });

  it("tier 2 does not match an episode on show-title tokens alone (Causality/Chernobyl for a Hyatt beat)", () => {
    const archive: TranscriptDigestEntry[] = [
      {
        show_id: "causality-engineered-network",
        show_title: "Causality — Engineered Network",
        guid: "c22",
        title: "22: Chernobyl",
        cues: 3,
        feed_duration_sec: 3600,
        span_implausible: false
      }
    ];
    const cues: TranscriptCue[] = [
      { text: "the original design called for a single hanger rod", start_sec: 10, end_sec: 14 },
      { text: "the fabricator found the connection impractical", start_sec: 14, end_sec: 18 }
    ];
    const spine: DeepenedAct[] = [
      makeDeepenedAct({
        slots: [
          {
            title: "Hyatt",
            beats: [{ claim: "The engineered hanger-rod network of the Kansas City walkway: the original design called for a single hanger rod.", exploration: false }]
          }
        ]
      })
    ];
    const result = sourceBeats(spine, { segmentPool: [], transcriptArchive: archive, cueProvider: { getCues: () => cues } });
    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("narration");
  });
});

/* WS-C (fix plan 2026-09-09): sourcing that knows what it is matching.
   Run 1 finished attempt 4 with 5 of 22 tape anchors on topic — the wrong ones
   included a British food-history segment, a barbecue show and four geology
   episodes, all inside a Foray about engineering disasters (F-06, F-23, F-24,
   F-29, F-33, F-38). The four groups below are the four things that fixes:
   beat KIND, transcript TEXT, the anchored WINDOW, and the topic GATE. */

describe("sourceBeats — F-38: an argument is narrated, never illustrated with tape", () => {
  /** F-38's own example, verbatim from the findings: run 1 anchored this to a
   * *Geology Bites* episode on banded iron formations. */
  const argumentClaim =
    "Every link in a failure chain gets evaluated against a local question — is this piece strong enough — and almost never against the global question of whether the system as a whole still holds.";

  function actWith(kind: "account" | "argument"): DeepenedAct[] {
    return [
      makeDeepenedAct({
        slots: [{ title: "The thesis", beats: [{ claim: argumentClaim, exploration: false, kind }] }]
      })
    ];
  }

  it("skips tape lookup entirely for a beat the deepen stage tagged an argument", () => {
    /* MUTATION THAT KILLS THIS: delete the `beat.kind === "argument"` branch in
       resolveOneBeat. The same claim then takes the fixture segment, which is
       exactly the F-38 failure. Ran it — red. */
    const pool: SegmentRecord[] = [
      {
        ...fixtureSegmentPool()[0]!,
        id: "geology-bites--banded-iron#100",
        item_id: "geology-bites--banded-iron",
        topic: "nature/earth-science",
        why: "Every question about a failure chain gets evaluated against the global system, link by link",
        start_anchor: "the local question is whether the link holds",
        end_anchor: "and the global question almost never gets asked"
      }
    ];
    const result = sourceBeats(actWith("argument"), { segmentPool: pool, transcriptArchive: [] });
    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("narration");
    // Nothing to transcribe would ever help, so nothing is queued either.
    expect(result.transcriptionQueueCandidates).toHaveLength(0);
    expect(result.tapeRelevance).toHaveLength(0);
  });

  it("still looks for tape for the same claim when it is tagged an account", () => {
    /* The kind must be what decides, not the claim's wording — otherwise the
       first test above would pass with the branch deleted and a coincidence. */
    const pool: SegmentRecord[] = [
      {
        ...fixtureSegmentPool()[0]!,
        id: "geology-bites--banded-iron#100",
        item_id: "geology-bites--banded-iron",
        topic: "nature/earth-science",
        why: "Every question about a failure chain gets evaluated against the global system, link by link",
        start_anchor: "the local question is whether the link holds",
        end_anchor: "and the global question almost never gets asked"
      }
    ];
    const result = sourceBeats(actWith("account"), { segmentPool: pool, transcriptArchive: [] });
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("tape");
  });

  it("carries the beat kind through to the sourced beat for §4.7", () => {
    const result = sourceBeats(actWith("argument"), { segmentPool: [], transcriptArchive: [] });
    expect(allSourcedBeats(result.acts)[0]!.kind).toBe("argument");
  });
});

describe("sourceBeats — F-06/F-29: tier 1 scores the claim against the tape's own words", () => {
  /** A pool segment cut from an episode the archive also holds a body for —
   * joined on `item_id` === `<show_id>--<title slug>`, the shape both sides
   * already use. */
  function hyattSegment(): SegmentRecord {
    return {
      ...fixtureSegmentPool()[0]!,
      id: "causality-engineered-network--47-hyatt-regency-kansas-city#972",
      item_id: "causality-engineered-network--47-hyatt-regency-kansas-city",
      topic: "engineering/disasters",
      start_sec: 972,
      end_sec: 1100,
      why: "A phone call splits one hanger rod into two and doubles the load on the box beam",
      start_anchor: "so the fabricator picks up the phone",
      end_anchor: "and the box beam is now carrying both walkways"
    };
  }

  function hyattEntry(): TranscriptDigestEntry {
    return {
      show_id: "causality-engineered-network",
      show_title: "Causality — Engineered Network",
      guid: "c47",
      title: "47: Hyatt Regency Kansas City",
      cues: 4,
      feed_duration_sec: 3600,
      span_implausible: false
    };
  }

  it("matches on words spoken INSIDE the segment that its 18-word why-line never mentions", () => {
    /* F-06, the recall half: "a beat about a specific point inside an episode
       can only match if the episode's title happens to share words with the
       claim" — the same is true of a segment's curator note. The words below
       (skywalk, atrium, tea dance) are in the tape and in the claim, and in no
       metadata field.

       MUTATION THAT KILLS THIS: drop `options.windowText` from
       scoreSegmentsAgainstClaim's haystack choice. Ran it — red. */
    const claim = "The second-floor skywalk fell into the crowded atrium during a Friday tea dance.";
    const cues: TranscriptCue[] = [
      { text: "unrelated cold open about the show itself", start_sec: 10, end_sec: 40 },
      { text: "the second floor skywalk came down into the atrium", start_sec: 980, end_sec: 1000 },
      { text: "during a friday tea dance with hundreds of people watching", start_sec: 1000, end_sec: 1020 }
    ];
    const result = sourceBeats([makeDeepenedAct({ slots: [{ title: "Collapse", beats: [{ claim, exploration: false }] }] })], {
      segmentPool: [hyattSegment()],
      transcriptArchive: [hyattEntry()],
      cueProvider: { getCues: () => cues }
    });
    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing === "tape") expect(beat.tape.tier).toBe(1);
  });

  it("refuses a segment whose why-line echoes the claim when the tape inside it does not", () => {
    /* The precision half, and the reason the window REPLACES the metadata
       rather than being added to it: a curator note is a proxy for the tape,
       and when the tape itself is available the proxy has no vote. Here the
       why-line is the claim almost verbatim while the window is about
       something else entirely. */
    const claim =
      "The original unrevised walkway design was already carrying roughly half the load required by the Kansas City building code before any revision reached the fabricator.";
    const segment: SegmentRecord = {
      ...hyattSegment(),
      why: "The original unrevised walkway design carried half the load the Kansas City code required",
      start_anchor: "the original walkway design and the kansas city code",
      end_anchor: "half of the required load before any revision"
    };
    const cues: TranscriptCue[] = [
      { text: "so we should talk about how the show got its name", start_sec: 970, end_sec: 1000 },
      { text: "and what listeners have been sending in this month", start_sec: 1000, end_sec: 1100 }
    ];
    const result = sourceBeats([makeDeepenedAct({ slots: [{ title: "Code", beats: [{ claim, exploration: false }] }] })], {
      segmentPool: [segment],
      transcriptArchive: [hyattEntry()],
      cueProvider: { getCues: () => cues }
    });
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
  });
});

describe("sourceBeats — F-24: tier 2 checks the tape AROUND the anchor, not the whole episode", () => {
  function entry(): TranscriptDigestEntry {
    return {
      show_id: "causality-engineered-network",
      show_title: "Causality — Engineered Network",
      guid: "c47",
      title: "47: Hyatt Regency Kansas City walkway collapse",
      cues: 6,
      feed_duration_sec: 3600,
      span_implausible: false
    };
  }

  const claim =
    "The Hyatt Regency Kansas City walkway collapse killed one hundred and fourteen people when the box beam connection failed.";

  it("does not mint tape when the anchor's own neighbourhood is about something else", () => {
    /* F-24(b), and after F-61 the same case stated on the window: "kansas city
       walkway collapse" is a passing mention in a listener-mail aside, and the
       claim's other content words are forty minutes away — the episode contains
       them, no 30-180 s stretch of it does. The best window carries 4 of the
       claim's 13 content words (0.31), below `TIER2_WINDOW_MIN_SHARE`.

       MUTATION THAT KILLS THIS: drop the share test from
       `tapeWindowIsRelevant` and keep only the ≥3-term count. The beat then
       takes those few seconds of tape. Ran it — red. */
    const cues: TranscriptCue[] = [
      { text: "a listener wrote in to ask about the kansas city walkway collapse", start_sec: 120, end_sec: 128 },
      { text: "but we are keeping that one for another day", start_sec: 128, end_sec: 134 },
      { text: "today we are talking about something else entirely", start_sec: 134, end_sec: 140 },
      { text: "the connection failed at the beam and the box gave way that evening", start_sec: 2400, end_sec: 2412 }
    ];
    const result = sourceBeats([makeDeepenedAct({ slots: [{ title: "Collapse", beats: [{ claim, exploration: false }] }] })], {
      segmentPool: [],
      transcriptArchive: [entry()],
      cueProvider: { getCues: () => cues }
    });
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    expect(result.transcriptionQueueCandidates[0]!.reason).toMatch(/best window of tape speaks 4 of the claim.s 13 content words, 4 of them rare/);
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("window-overlap");
    expect(tier2.windowTermShare).toBeLessThan(0.35);
  });

  it("mints tape when the claim's own words are spoken around the anchor", () => {
    const cues: TranscriptCue[] = [
      { text: "the kansas city walkway collapse is the case every engineer is taught", start_sec: 600, end_sec: 608 },
      { text: "the box beam connection failed under a doubled load", start_sec: 608, end_sec: 616 },
      { text: "one hundred and fourteen people were killed that evening", start_sec: 616, end_sec: 624 }
    ];
    const result = sourceBeats([makeDeepenedAct({ slots: [{ title: "Collapse", beats: [{ claim, exploration: false }] }] })], {
      segmentPool: [],
      transcriptArchive: [entry()],
      cueProvider: { getCues: () => cues }
    });
    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing === "tape") expect(beat.tape.tier).toBe(2);
  });
});

describe("sourceBeats — F-24(c): what tier 2 mints is a segment, not the anchor's own few seconds", () => {
  const claim =
    "The Hyatt Regency Kansas City walkway collapse killed one hundred and fourteen people when the box beam connection failed.";

  function entry(): TranscriptDigestEntry {
    return {
      show_id: "causality-engineered-network",
      show_title: "Causality — Engineered Network",
      guid: "c47",
      title: "47: Hyatt Regency Kansas City walkway collapse",
      cues: 9,
      feed_duration_sec: 3600,
      span_implausible: false
    };
  }

  /** Nine ten-second cues. The claim's longest verbatim run ("the box beam
   * connection failed") is spoken in exactly one of them, at 640-650. */
  function cues(): TranscriptCue[] {
    return [
      { text: "welcome back to the show and thanks for listening this week", start_sec: 600, end_sec: 610 },
      { text: "we have a lot of ground to cover in this episode today", start_sec: 610, end_sec: 620 },
      { text: "so let us begin with the building itself and its atrium", start_sec: 620, end_sec: 630 },
      { text: "the kansas city walkway collapse is taught in every course", start_sec: 630, end_sec: 640 },
      { text: "the box beam connection failed under a doubled load that night", start_sec: 640, end_sec: 650 },
      { text: "one hundred and fourteen people were killed in the atrium", start_sec: 650, end_sec: 660 },
      { text: "and more than two hundred others were badly injured", start_sec: 660, end_sec: 670 },
      { text: "the enquiry that followed took the better part of a year", start_sec: 670, end_sec: 680 },
      { text: "we will come back to what it concluded after the break", start_sec: 680, end_sec: 690 }
    ];
  }

  function mint() {
    const result = sourceBeats([makeDeepenedAct({ slots: [{ title: "Collapse", beats: [{ claim, exploration: false }] }] })], {
      segmentPool: [],
      transcriptArchive: [entry()],
      cueProvider: { getCues: () => cues() }
    });
    return result;
  }

  it("cuts the minted span to WHOLE cues either side of the anchor, never one cue's few seconds", () => {
    /* F-24(c) verbatim: "the minted segment spans ONLY that anchor window
       (`startSec` of its first word to `endSec` of its last) — a few seconds of
       audio, not a segment". The anchor here is inside the 640-650 cue, so the
       pre-fix code produced [640, 650] and nothing wider.

       MUTATION THAT KILLS THIS: return the plain phrase span from
       resolveAnchorFromCues (startSec = startTimes[at]). The span becomes
       [640, 650]: still cue-aligned, since a token carries its cue's times, but
       one cue wide — so the whole-cue COUNT below is what does the pinning
       here, not the alignment. Ran it — red. */
    const segment = mint().newSegments[0]!;
    const starts = cues().map((c) => c.start_sec);
    const ends = cues().map((c) => c.end_sec);
    expect(starts).toContain(segment.startSec);
    expect(ends).toContain(segment.endSec);
    const whollyInside = cues().filter((c) => c.start_sec >= segment.startSec && c.end_sec <= segment.endSec);
    expect(whollyInside.length).toBeGreaterThanOrEqual(3);
  });

  it("stops at a segment-length piece of tape and never runs past the claim (F-62)", () => {
    /* WHAT CHANGED AND WHY (F-62). This case used to assert the span reached
       `MIN_TAPE_SEGMENT_SEC` unconditionally, which is what symmetric padding
       guarantees and what made run 2's one mint open with tape about something
       else. It now asserts the rule that replaced it: the span covers the cues
       that carry the claim (630-670 here), stops there because neither
       neighbour says anything the claim says — the show's welcome, and the
       enquiry that followed — and stays a playable length. */
    const segment = mint().newSegments[0]!;
    expect(segment.startSec).toBe(630);
    expect(segment.endSec).toBe(670);
    expect(segment.endSec - segment.startSec).toBeGreaterThanOrEqual(ABSOLUTE_MIN_TAPE_SEGMENT_SEC);
    expect(segment.endSec - segment.startSec).toBeLessThanOrEqual(MAX_TAPE_SEGMENT_SEC);
    /* The two cues it refused, named: 620-630 "the building itself and its
       atrium" and 670-680 "the enquiry that followed". */
    expect(segment.startSec).toBeGreaterThan(620);
    expect(segment.endSec).toBeLessThan(680);
  });

  it("anchors the cut span at its own boundaries rather than quoting the matched phrase twice", () => {
    /* The pre-fix span set BOTH anchors to the matched phrase, which is now
       neither at `startSec` nor at `endSec` — `merge-segments.mjs` checks an
       anchor appears verbatim AND near the time the segment claims for it, so
       reusing the phrase here would be a segment whose own validator rejects
       it. */
    const segment = mint().newSegments[0]!;
    expect(segment.startAnchor).not.toBe(segment.endAnchor);
    expect(segment.startAnchor.split(" ").length).toBeGreaterThanOrEqual(4);
    expect(segment.endAnchor.split(" ").length).toBeGreaterThanOrEqual(4);
    // Verbatim, from the cues at the two boundaries — not the claim's words.
    const spoken = cues().map((c) => c.text.toLowerCase());
    expect(spoken.some((t) => t.includes(segment.startAnchor))).toBe(true);
    expect(spoken.some((t) => t.includes(segment.endAnchor))).toBe(true);
    expect(segment.startAnchor).not.toContain("box beam connection failed");
  });

  it("still judges relevance by the matched phrase's own neighbourhood, not the cut span's edges", () => {
    /* The window check and the cut must not be allowed to feed each other: a
       wider cut would otherwise widen the window it is judged by, so a segment
       could grow its way into looking on topic. `anchoredWindowEvidence` reads
       `matchedPhrase`/`matchStartSec` for exactly this reason. */
    const beat = allSourcedBeats(mint().acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    const off = sourceBeats([makeDeepenedAct({ slots: [{ title: "Collapse", beats: [{ claim, exploration: false }] }] })], {
      segmentPool: [],
      transcriptArchive: [entry()],
      // Same anchor cue, but the claim's other words are now an hour away; the
      // cut still reaches segment length and the beat must still be refused.
      cueProvider: {
        getCues: () => [
          { text: "so let us begin with the building itself and its atrium", start_sec: 620, end_sec: 630 },
          { text: "a quick word about something entirely unrelated first", start_sec: 630, end_sec: 640 },
          { text: "the box beam connection failed under a doubled load that night", start_sec: 640, end_sec: 650 },
          { text: "anyway that is enough about the sponsor for this week", start_sec: 650, end_sec: 660 },
          { text: "the enquiry that followed took the better part of a year", start_sec: 660, end_sec: 690 },
          { text: "the kansas city walkway collapse is a famous case", start_sec: 3000, end_sec: 3010 },
          { text: "one hundred and fourteen people died there", start_sec: 3300, end_sec: 3310 }
        ]
      }
    });
    expect(allSourcedBeats(off.acts)[0]!.sourcing).toBe("narration");
  });
});

describe("sourceBeats — F-29/F-23: the topic gate, and the tapeRelevance rows WS-B aggregates", () => {
  const engineeringClaim =
    "The walkway hanger rod carried a load the original connection detail was never designed to hold, and the change was made over the phone.";

  /** The food-history segment run 1 actually anchored an engineering beat to,
   * with its why-line rewritten to overlap the claim heavily — the gate has to
   * hold even when the word count says yes. */
  function foodSegment(): SegmentRecord {
    return {
      ...fixtureSegmentPool()[0]!,
      id: "bfh-griddle-bakestone#740",
      item_id: "bfh-griddle-bakestone",
      topic: "food/food-history",
      why: "A hanger over the hearth carried a load the original connection was never designed to hold",
      start_anchor: "the hanger and the load it carried",
      end_anchor: "the original connection detail over the fire"
    };
  }

  it("refuses a tier-1 segment from another taxonomy family however many words it shares", () => {
    /* MUTATION THAT KILLS THIS: drop the `familyGateAllows` clause from the
       tier-1 isUsable predicate. The food segment scores far over the bar and
       is taken. Ran it — red. */
    const acts = [makeDeepenedAct({ slots: [{ title: "Hyatt", beats: [{ claim: engineeringClaim, exploration: false }] }] })];
    const gated = sourceBeats(acts, { segmentPool: [foodSegment()], transcriptArchive: [], topic: "engineering/disasters" });
    expect(allSourcedBeats(gated.acts)[0]!.sourcing).toBe("narration");

    // Same inputs, no resolved topic: the gate is inert and the old behaviour stands.
    const ungated = sourceBeats(acts, { segmentPool: [foodSegment()], transcriptArchive: [] });
    expect(allSourcedBeats(ungated.acts)[0]!.sourcing).toBe("tape");
  });

  it("refuses a tier-2 episode whose show is classified under another family", () => {
    /* *Geology Bites* is `nature/earth-science` in data/catalog.json; run 1 gave
       it an engineering beat (F-38's anchor). The cues below would otherwise
       anchor cleanly. */
    const archive: TranscriptDigestEntry[] = [
      {
        show_id: "geology-bites",
        show_title: "Geology Bites",
        guid: "gb-42",
        title: "The hanger rod load and the connection detail that failed",
        cues: 3,
        feed_duration_sec: 3600,
        span_implausible: false
      }
    ];
    const cues: TranscriptCue[] = [
      { text: "the walkway hanger rod carried a load the original connection detail", start_sec: 100, end_sec: 110 },
      { text: "was never designed to hold and the change was made over the phone", start_sec: 110, end_sec: 120 }
    ];
    const acts = [makeDeepenedAct({ slots: [{ title: "Hyatt", beats: [{ claim: engineeringClaim, exploration: false }] }] })];
    const gated = sourceBeats(acts, { segmentPool: [], transcriptArchive: archive, cueProvider: { getCues: () => cues }, topic: "engineering/disasters" });
    expect(allSourcedBeats(gated.acts)[0]!.sourcing).toBe("narration");

    const ungated = sourceBeats(acts, { segmentPool: [], transcriptArchive: archive, cueProvider: { getCues: () => cues } });
    expect(allSourcedBeats(ungated.acts)[0]!.sourcing).toBe("tape");
  });

  it("emits one tapeRelevance row per tape beat, with both families and the on-topic verdict", () => {
    /* WS-B's `tapeRelevance` metric is "share of tape anchors whose episode
       shares a taxonomy family with the Foray's resolved topic, plus the list
       of anchors for human spot-check". Run 1 had to count that by hand from
       the narration prompts. */
    const onTopic: SegmentRecord = {
      ...fixtureSegmentPool()[0]!,
      id: "causality-engineered-network--47-hyatt-regency-kansas-city#972",
      item_id: "causality-engineered-network--47-hyatt-regency-kansas-city",
      topic: "engineering/disasters",
      why: "The walkway hanger rod carried a load the original connection detail was never designed to hold"
    };
    const result = sourceBeats(
      [makeDeepenedAct({ slots: [{ title: "Hyatt", beats: [{ claim: engineeringClaim, exploration: false }] }] })],
      { segmentPool: [onTopic], transcriptArchive: [], topic: "engineering/disasters" }
    );
    expect(result.tapeRelevance).toHaveLength(1);
    expect(result.tapeRelevance[0]).toMatchObject({
      actIndex: 0,
      slotIndex: 0,
      beatIndex: 0,
      itemId: "causality-engineered-network--47-hyatt-regency-kansas-city",
      tier: 1,
      forayTopic: "engineering/disasters",
      forayFamily: "engineering",
      onTopic: true
    });
    /* `claim`, `itemId`, `onTopic` and `families` are the four fields WS-B's
       own `TapeAnchorNote` carries, spelled the same way and holding the same
       values, so `veracityMetrics.ts` can aggregate these rows instead of
       re-deriving the join from disk — and so the gate and the metric that
       scores the gate can never report different things about one anchor. */
    expect(result.tapeRelevance[0]!.claim).toBe(engineeringClaim);
    expect(result.tapeRelevance[0]!.families).toEqual(["engineering"]);
    expect(result.tapeRelevance[0]!.taxonomyNodeIds).toContain("engineering/disasters");
  });

  it("reports onTopic null — never true — when sourcing ran without a resolved topic", () => {
    /* "I could not tell" must not be counted as a pass by WS-B's gate. `null`
       rather than `false` because WS-B excludes an unresolvable anchor from the
       metric's numerator AND denominator; calling it `false` would report a
       measurement that was never taken. */
    const result = sourceBeats(
      [makeDeepenedAct({ slots: [{ title: "Hyatt", beats: [{ claim: engineeringClaim, exploration: false }] }] })],
      { segmentPool: [foodSegment()], transcriptArchive: [] }
    );
    expect(result.tapeRelevance).toHaveLength(1);
    expect(result.tapeRelevance[0]!.forayTopic).toBeNull();
    expect(result.tapeRelevance[0]!.forayFamily).toBeNull();
    expect(result.tapeRelevance[0]!.onTopic).toBeNull();
    // The candidate's own side is still reported — that half is knowable.
    expect(result.tapeRelevance[0]!.families).toEqual(["food"]);
  });
});

describe("sourceBeats — the topic gate is a LINEAGE, not a shared first path segment", () => {
  /* WS-F's F-11 correction, applied here: a root-segment rule ("both start
     with `engineering`") is too coarse, because it puts every one of a root's
     children in scope of every other. A family is a node's lineage in
     data/taxonomy.json — itself, its ancestors, its descendants. */
  const claim = "The walkway hanger rod carried a load the original connection detail was never designed to hold.";

  /** A segment with no resolvable show, so its ONLY taxonomy signal is the
   * `topic` under test — nothing sneaks in through the catalogue union. */
  function segmentWithTopic(topic: string): SegmentRecord {
    return {
      ...fixtureSegmentPool()[0]!,
      id: `fixture-${topic.replace(/[^a-z]+/g, "-")}#10`,
      item_id: `fixture-item-${topic.replace(/[^a-z]+/g, "-")}`,
      topic,
      why: "The walkway hanger rod carried a load the original connection detail was never designed to hold",
      start_anchor: "the hanger rod and the load it carried",
      end_anchor: "the original connection detail it was never designed to hold"
    };
  }

  function sourcedWith(topic: string, segmentTopic: string) {
    const result = sourceBeats(
      [makeDeepenedAct({ slots: [{ title: "Hyatt", beats: [{ claim, exploration: false }] }] })],
      { segmentPool: [segmentWithTopic(segmentTopic)], transcriptArchive: [], topic }
    );
    return allSourcedBeats(result.acts)[0]!.sourcing;
  }

  it("refuses a SIBLING node under the same root", () => {
    /* MUTATION THAT KILLS THIS: make the gate compare `taxonomyRoot` on both
       sides instead of walking the lineage. `engineering/precision-mfg` then
       passes for an `engineering/disasters` Foray on the strength of sharing
       the word "engineering", which is the coarse rule this replaced. Ran it
       — red. */
    expect(sourcedWith("engineering/disasters", "engineering/precision-mfg")).toBe("narration");
  });

  it("allows the node itself, its ANCESTOR, and its DESCENDANT", () => {
    // Same node.
    expect(sourcedWith("engineering/disasters", "engineering/disasters")).toBe("tape");
    // Parent: a show the catalogue never classified more precisely than the
    // root is still the same subject, and refusing it would throw away tape
    // for a curator's choice not to be specific.
    expect(sourcedWith("engineering/disasters", "engineering")).toBe("tape");
    // Descendant: the mirror case, a broad Foray reaching narrow tape.
    expect(sourcedWith("engineering", "engineering/precision-mfg")).toBe("tape");
  });

  it("refuses another root outright", () => {
    expect(sourcedWith("engineering/disasters", "food/food-history")).toBe("narration");
  });
});

describe("sourceBeats — run 1 replay: the real beats against the real data/segments.json", () => {
  /* The run-1 Foray, verbatim from the findings: "How engineering disasters
     actually happen: the chains of small decisions behind collapsed bridges,
     failed dams and machines that broke", resolved topic `engineering/disasters`.
     Its attempt-4 anchors were 5 on topic out of 22; among the wrong ones were
     `bfh-griddle-bakestone` (food/food-history, F-29), *Grill Coach*
     (food/grilling-bbq) and four geology episodes.

     The pool here is the REAL 212-row `data/segments.json`, and the cue
     provider returns null so the test is identical on a machine with
     `data-local/` transcripts and on CI without them. */
  const FORAY_TOPIC = "engineering/disasters";

  /** Beat 4, verbatim from F-29 — the claim that took the griddle segment. */
  const beat4Claim =
    "The original, unrevised design was already carrying roughly half the load required by the Kansas City building code, so a full structural review — had one occurred — would likely have found the walkway inadequate even without the phone-call revision, meaning the design was failing before the failure that killed people.";

  /** Beat 5. The findings record its ANCHOR (*Grill Coach*, a barbecue show)
   * rather than its wording, so the claim is reconstructed from the run's own
   * running order — the collapse itself, which is where beats 1-5 had reached.
   * What is being pinned is the anchor's domain, and that does not depend on
   * the reconstruction being word-perfect. */
  const beat5Claim =
    "When the second- and fourth-floor walkways came down into the crowded atrium during a Friday tea dance, one hundred and fourteen people were killed and more than two hundred were injured.";

  function replay(claim: string) {
    return sourceBeats([makeDeepenedAct({ slots: [{ title: "Hyatt Regency", beats: [{ claim, exploration: false }] }] })], {
      segmentPool: loadSegmentPool(),
      transcriptArchive: [],
      cueProvider: { getCues: () => null },
      topic: FORAY_TOPIC
    });
  }

  it.each([
    ["beat 4 (Kansas City code load, verbatim from F-29)", beat4Claim],
    ["beat 5 (the collapse; anchored to a barbecue show in run 1)", beat5Claim]
  ])("%s takes engineering tape or none — never another domain's", (_label, claim) => {
    /* WHAT THIS PINS, STATED HONESTLY. This is an end-to-end outcome test on the
       real pool, not a pin on any single clause. Measured on both claims with
       the topic gate removed: they still take engineering tape or none, because
       I-13's stopword list and I-16's threshold of 3 already hold every
       food/nature candidate at score 1 for these two claims (beat 4's ranked
       list is Hyatt #972 at 4, then two more Hyatt segments at 2, then
       everything else at 1). The gate's own pinning tests are the fixture ones
       above, where an off-family segment scores well over the bar and is
       refused anyway. What would kill THIS test is any regression in the whole
       stack — tokenizer, threshold, gate, ranked walk — which is what a replay
       of a real, published failure is for. */
    const result = replay(claim);
    const byId = new Map(loadSegmentPool().map((s) => [s.id, s]));
    for (const row of result.tapeRelevance) {
      const segment = byId.get(row.segmentId);
      expect(segment, `anchor ${row.segmentId} is not in the real pool`).toBeDefined();
      expect(segment!.topic, `${row.itemId} is ${segment!.topic}, not engineering`).toMatch(/^engineering(\/|$)/);
      expect(row.onTopic).toBe(true);
    }
    // And whatever it did, the beat still exists.
    expect(allSourcedBeats(result.acts)).toHaveLength(1);
  });

  it("no beat of the run-1 Foray can reach a food or nature segment", () => {
    const result = sourceBeats(
      [
        makeDeepenedAct({
          slots: [
            {
              title: "Hyatt Regency",
              beats: [
                { claim: beat4Claim, exploration: false },
                { claim: beat5Claim, exploration: false }
              ]
            }
          ]
        })
      ],
      { segmentPool: loadSegmentPool(), transcriptArchive: [], cueProvider: { getCues: () => null }, topic: FORAY_TOPIC }
    );
    const families = result.tapeRelevance.flatMap((r) => r.families);
    expect(families.every((f) => f === "engineering")).toBe(true);
    expect(result.tapeRelevance.some((r) => /griddle|grill|bbq|geology/.test(r.itemId))).toBe(false);
    /* Beat 4's right answer is not "nothing": the Hyatt Regency segment is in
       the pool and its why-line is the phone call that doubled the load. Run 1
       reached the griddle only after the ranked walk left it. */
    expect(result.tapeRelevance.map((r) => r.itemId)).toContain("causality-engineered-network--47-hyatt-regency-kansas-city");
  });
});

describe("sourceBeats — F-33: two shared trade words inside one topic are not a match", () => {
  it("a hanger-rod fabrication claim is not anchored to the Chernobyl episode when the Hyatt segment is spoken for", () => {
    const hyatt: SegmentRecord = {
      ...loadSegmentPool().find((s) => s.id === "causality-engineered-network--47-hyatt-regency-kansas-city#972")!
    };
    const chernobyl: SegmentRecord = {
      ...hyatt,
      id: "causality-engineered-network--22-chernobyl#100",
      item_id: "causality-engineered-network--22-chernobyl",
      start_sec: 100,
      end_sec: 400,
      why: "How a reactor design problem and an operator's test plan combined at Chernobyl",
      start_anchor: "the design of the reactor had a problem",
      end_anchor: "and the procedure was never checked"
    };
    const rodClaim =
      "The change — splitting one continuous hanger rod running through both walkways into two separate, offset rods — was proposed as a fix for a fabrication problem: the original design required threading a nut sixty times up thirty feet of rod.";
    const spine: DeepenedAct[] = [
      makeDeepenedAct({
        slots: [
          {
            title: "Hyatt",
            beats: [
              { claim: "A phone call split one hanger rod into two and doubled the load on the box beam.", exploration: false },
              { claim: rodClaim, exploration: false }
            ]
          }
        ]
      })
    ];
    const result = sourceBeats(spine, { segmentPool: [hyatt, chernobyl], transcriptArchive: [], cueProvider: { getCues: () => null } });
    const beats = allSourcedBeats(result.acts);
    expect(beats[0]!.sourcing).toBe("tape");
    const second = beats[1]!;
    if (second.sourcing === "tape") expect(second.tape.itemId).not.toMatch(/chernobyl/);
  });
});

describe("sourceBeats — F-49: every narrated beat says which gate refused it", () => {
  /**
   * Run 2 produced 35 beats, 0 of them tape, and the only account it could give
   * of itself was one sentence repeated six times ("No tape found anywhere in
   * the §4.5 search order") — which cannot tell "the pool holds nothing about
   * AI" apart from "the best episode was one title token short" apart from "the
   * taxonomy gate refused it". Every threshold in §4.5 was being tuned by
   * argument. These cases pin the evidence rows that replace the argument.
   */
  function oneBeat(claim: string, kind?: "account" | "argument"): DeepenedAct[] {
    return [
      makeDeepenedAct(
        { slots: [{ title: "The only slot", beats: [{ claim, exploration: false, ...(kind ? { kind } : {}) }] }] },
        "Trace"
      )
    ];
  }

  it("says `skipped:argument`, with no tier rows at all, for a beat §4.4 tagged an argument", () => {
    const result = sourceBeats(oneBeat("Every link in a failure chain is judged against a local question.", "argument"), {
      segmentPool: fixtureSegmentPool(),
      transcriptArchive: []
    });
    expect(result.sourcingTrace).toHaveLength(1);
    const trace = result.sourcingTrace[0]!;
    expect(trace.outcome).toBe("skipped:argument");
    expect(trace.tier1).toBeNull();
    expect(trace.tier2).toBeNull();
    expect(trace).toMatchObject({ actIndex: 0, slotIndex: 0, beatIndex: 0 });
  });

  it("names tier 1's best candidate, its score, its bar and the gate that refused it", () => {
    /* The claim shares one content word ("criterion") with the pooled segment's
       metadata, so the best candidate is real but under its own threshold.
       MUTATION THAT KILLS THIS: report the gate without the score — the row
       stops saying how far off the bar was, which is the only number a
       threshold decision can be made from. */
    const result = sourceBeats(oneBeat("The Lawson criterion was printed on a poster in the hallway."), {
      segmentPool: fixtureSegmentPool(),
      transcriptArchive: []
    });
    const tier1 = result.sourcingTrace[0]!.tier1!;
    expect(tier1.bestSegmentId).toBe("lex-353-whyte#2530");
    expect(tier1.bestItemId).toBe("lex-353-whyte");
    expect(tier1.matchedIn).toBe("metadata");
    expect(tier1.score).toBeGreaterThan(0);
    expect(tier1.score).toBeLessThan(tier1.requiredScore);
    expect(tier1.gate).toBe("threshold");
  });

  it("reports `no-candidates` when nothing in the pool shares a single content word", () => {
    const result = sourceBeats(oneBeat("Briquette manufacturing consumed enormous quantities of sawdust."), {
      segmentPool: [],
      transcriptArchive: []
    });
    expect(result.sourcingTrace[0]!.tier1).toMatchObject({ bestSegmentId: null, score: 0, matchedIn: null, gate: "no-candidates" });
  });

  it("reports tier 1's `exhausted` gate when an earlier beat of the same Foray already played the best segment", () => {
    /* F-29's "exhaustion of the one relevant episode" — the state that sent run
       1's Kansas City beat to a British hearth-cooking segment. Two beats, one
       segment: the second one's trace must say the segment was taken, not that
       nothing matched. */
    const claim = "The Lawson criterion is a statement about plasma confinement in a tokamak.";
    const acts: DeepenedAct[] = [
      makeDeepenedAct(
        {
          slots: [
            {
              title: "Twice over",
              beats: [
                { claim, exploration: false },
                { claim, exploration: false }
              ]
            }
          ]
        },
        "Exhaust"
      )
    ];
    const result = sourceBeats(acts, { segmentPool: fixtureSegmentPool(), transcriptArchive: [] });
    expect(result.tapeRelevance).toHaveLength(1);
    expect(result.sourcingTrace).toHaveLength(1);
    expect(result.sourcingTrace[0]!.tier1!.gate).toBe("exhausted");
    expect(result.sourcingTrace[0]!.tier1!.bestSegmentId).toBe("lex-353-whyte#2530");
  });

  it("names tier 2's best episode and the title-token bar it missed", () => {
    const archive: TranscriptDigestEntry[] = [
      {
        show_id: "geology-bites",
        show_title: "Geology Bites",
        guid: "geo-ep-42",
        title: "How volcanic ash layers date the Roman eruption record",
        cues: 3,
        feed_duration_sec: 3600
      }
    ];
    const result = sourceBeats(oneBeat("Volcanic sediment accumulated slowly."), { segmentPool: [], transcriptArchive: archive });
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.bestEpisodeTitle).toBe("How volcanic ash layers date the Roman eruption record");
    expect(tier2.bestShowId).toBe("geology-bites");
    expect(tier2.score).toBeLessThan(tier2.requiredScore);
    expect(tier2.gate).toBe("title-tokens");
  });

  it("distinguishes `no-body` (the episode matched, the transcript is not on this machine) from a miss", () => {
    const archive: TranscriptDigestEntry[] = [
      {
        show_id: "geology-bites",
        show_title: "Geology Bites",
        guid: "geo-ep-42",
        title: "How volcanic ash layers date the Roman eruption record",
        cues: 3,
        feed_duration_sec: 3600
      }
    ];
    const result = sourceBeats(oneBeat("Volcanic ash layers date the Roman eruption record precisely."), {
      segmentPool: [],
      transcriptArchive: archive,
      cueProvider: { getCues: () => null }
    });
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("no-body");
    expect(tier2.score).toBeGreaterThanOrEqual(tier2.requiredScore);
  });

  it("reports `window-overlap`, with the window's own numbers, when no stretch of the tape is about the claim", () => {
    /* F-24 in trace form, restated by F-61: the episode says the subject's name
       once and nothing else the claim says, so the best window of it carries
       three of eleven content words. The row carries the words themselves and
       the share, which is what makes `TIER2_WINDOW_MIN_SHARE` arguable from
       data rather than from taste. */
    const archive: TranscriptDigestEntry[] = [
      {
        show_id: "geology-bites",
        show_title: "Geology Bites",
        guid: "geo-ep-9",
        title: "Banded iron formations and the great oxidation event",
        cues: 4,
        feed_duration_sec: 3600
      }
    ];
    const cues: TranscriptCue[] = [
      { text: "and then we moved on to the next thing", start_sec: 10, end_sec: 16 },
      { text: "banded iron formations came up on the show once", start_sec: 16, end_sec: 22 },
      { text: "which is a completely different subject entirely", start_sec: 22, end_sec: 28 },
      { text: "anyway back to the rocks we were discussing", start_sec: 28, end_sec: 34 }
    ];
    const result = sourceBeats(oneBeat("Banded iron formations and the great oxidation event reshaped atmospheric chemistry worldwide forever."), {
      segmentPool: [],
      transcriptArchive: archive,
      cueProvider: { getCues: () => cues }
    });
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("window-overlap");
    expect(tier2.windowMatchedTerms).toEqual(["banded", "iron", "formations"]);
    expect(tier2.windowTermShare).toBeCloseTo(3 / 11, 2);
    /* With no text index there is no idf, so the weighted share is the plain
       one — the floor means the same thing either way. */
    expect(tier2.windowWeightedShare).toBe(tier2.windowTermShare);
    /* The tighter of two windows with the same coverage: the mention onward,
       not the whole transcript. */
    expect(tier2.windowStartSec).toBe(16);
    expect(tier2.windowEndSec).toBe(34);
  });

  it("summarises each slot in one line: how much tape, how much narration, and the top reason", () => {
    const acts: DeepenedAct[] = [
      makeDeepenedAct(
        {
          slots: [
            {
              title: "Mixed slot",
              beats: [
                { claim: "The Lawson criterion is a statement about plasma confinement in a tokamak.", exploration: false },
                { claim: "Every failure chain is generally judged locally.", exploration: false, kind: "argument" },
                { claim: "Briquette manufacturing consumed enormous quantities of sawdust.", exploration: false }
              ]
            }
          ]
        },
        "Summary"
      )
    ];
    const result = sourceBeats(acts, { segmentPool: fixtureSegmentPool(), transcriptArchive: [] });
    const lines = summarizeSourcing(result);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/^source: act 1 slot 1 "Mixed slot" — 1 tape \/ 2 narration; top reason: /);
  });
});

describe("sourceBeats — F-49: tier 2 will not mint tape nothing can play", () => {
  const archive: TranscriptDigestEntry[] = [
    {
      show_id: "geology-bites",
      show_title: "Geology Bites",
      guid: "geo-ep-42",
      title: "How volcanic ash layers date the Roman eruption record",
      cues: 3,
      feed_duration_sec: 3600,
      enclosure_url: "https://cdn.example/geo-ep-42.mp3"
    }
  ];
  const cues: TranscriptCue[] = [
    { text: "Today we discuss how volcanic ash layers", start_sec: 100, end_sec: 105 },
    { text: "date the Roman eruption record precisely using", start_sec: 105, end_sec: 111 },
    { text: "radiometric methods developed over decades of fieldwork", start_sec: 111, end_sec: 118 }
  ];
  const claim = "Volcanic ash layers date the Roman eruption record precisely using radiometric methods.";
  const acts = (): DeepenedAct[] => [
    makeDeepenedAct({ slots: [{ title: "Volcanic dating", beats: [{ claim, exploration: false }] }] }, "Volcano")
  ];

  it("emits the episode's segment-sources row alongside the minted segment", () => {
    /* Without the row, `check-forays.mjs` refuses the pool item id ("nothing
       can resolve its audio") and the Foray fails §4.9 — which is what would
       have happened to the first Foray this pipeline sourced tier-2 tape for. */
    const result = sourceBeats(acts(), {
      segmentPool: [],
      transcriptArchive: archive,
      cueProvider: { getCues: () => cues },
      audioSourceFor: (entry, itemId) =>
        mintSegmentSource(entry, itemId, new Map([["geology-bites", { dai: false, feedUrl: "https://example.invalid/f.xml", appleCollectionId: null }]]))
    });
    expect(result.newSegments).toHaveLength(1);
    expect(result.newSegmentSources).toHaveLength(1);
    expect(result.newSegmentSources[0]!.id).toBe(result.newSegments[0]!.itemId);
    expect(result.newSegmentSources[0]!.audio_url).toBe("https://cdn.example/geo-ep-42.mp3");
    expect(result.newSegmentSources[0]!.duration_sec).toBe(3600);
  });

  it("degrades the beat to narration, with gate `no-audio-source`, when no honest source row can be written", () => {
    const result = sourceBeats(acts(), {
      segmentPool: [],
      transcriptArchive: archive,
      cueProvider: { getCues: () => cues },
      audioSourceFor: () => null
    });
    expect(result.newSegments).toHaveLength(0);
    expect(result.newSegmentSources).toHaveLength(0);
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    expect(result.sourcingTrace[0]!.tier2!.gate).toBe("no-audio-source");
  });

  it("is inert when no resolver is supplied, so every caller that predates one is unaffected", () => {
    const result = sourceBeats(acts(), { segmentPool: [], transcriptArchive: archive, cueProvider: { getCues: () => cues } });
    expect(result.newSegments).toHaveLength(1);
    expect(result.newSegmentSources).toHaveLength(0);
  });
});

describe("sourceBeats — run 2 replay: why 35 beats found no tape (F-49)", () => {
  /**
   * The deepen output of generation run 2, lifted verbatim from its checkpoint,
   * sourced against the real `data/segments.json` and the real transcript
   * digests with NO transcript bodies (the state a fresh checkout is in). This
   * is the run F-49 was written from; what it pins is the DIAGNOSIS, not a
   * count of tape — the archive's answer for these claims is a fact about the
   * catalogue, not about this module.
   */
  const RUN2: DeepenedAct[] = (
    JSON.parse(readFileSync(join(__dirname, "fixtures", "run2-deepen-2026-09-09.json"), "utf8")) as { acts: DeepenedAct[] }
  ).acts;

  /* The topic run 2 resolved, passed explicitly so this case does not depend on
     `resolveTopic` — which resolved an AI/ML prompt to `engineering/energy-fusion`,
     itself worth a finding, and not one this test should be hostage to. */
  const RUN2_TOPIC = "engineering/energy-fusion";

  it("as it ran: 29 of 35 beats never searched at all, and the six that did are traced tier by tier", () => {
    const result = sourceBeats(RUN2, { topic: RUN2_TOPIC, cueProvider: { getCues: () => null } });
    expect(result.sourcingTrace).toHaveLength(35);
    expect(result.tapeRelevance).toHaveLength(0);

    const skipped = result.sourcingTrace.filter((t) => t.outcome === "skipped:argument");
    expect(skipped).toHaveLength(29);

    const searched = result.sourcingTrace.filter((t) => t.outcome === "no-tape");
    expect(searched).toHaveLength(6);
    for (const trace of searched) {
      expect(trace.tier1).not.toBeNull();
      expect(trace.tier2).not.toBeNull();
    }
  });

  it("names the gate for the ImageNet beat and the Amazon-latency beat — the two the fix has to answer for", () => {
    const result = sourceBeats(RUN2, { topic: RUN2_TOPIC, cueProvider: { getCues: () => null } });
    const byClaim = (needle: string) => result.sourcingTrace.find((t) => t.claim.includes(needle))!;

    /* ImageNet: the pool's best candidate is a *Causality* episode scoring
       under its own bar, and tier 2's best episode of any family is a
       divorce-attorney episode — which two shared title tokens would have
       admitted. This is the row that says lowering `TIER2_MATCH_THRESHOLD`
       to 2 buys run 1's Chernobyl mis-anchor back. */
    const imagenet = byClaim("ImageNet");
    expect(imagenet.outcome).toBe("no-tape");
    expect(imagenet.tier1!.score).toBeLessThan(imagenet.tier1!.requiredScore);
    expect(imagenet.tier1!.gate).toBe("threshold");
    expect(imagenet.tier2!.score).toBeLessThan(imagenet.tier2!.requiredScore);
    expect(["title-tokens", "lineage"]).toContain(imagenet.tier2!.gate);

    /* Amazon latency: tier 1's best candidate CLEARED the score bar (3 of 3) —
       and was refused by the taxonomy gate, because it is the San Bruno gas
       pipeline explosion. The gate doing its job is the difference between
       this run and run 1, and the trace is what makes it visible. */
    const latency = byClaim("Greg Linden");
    expect(latency.tier1!.score).toBeGreaterThanOrEqual(latency.tier1!.requiredScore);
    expect(latency.tier1!.gate).toBe("topic-lineage");
    expect(latency.tier1!.bestItemId).toContain("causality");
  });

  it("with the argument cap applied, 23 beats search instead of 6 — and the archive still has nothing for them", () => {
    /* The other half of F-49's diagnosis, and the reason this PR does not touch
       a threshold: even with four times as many beats searching, tier 2 stops
       at the title-token bar every time. Tier 2 reads episode TITLES, never
       transcript text (F-06), and no *Practical AI* title shares three content
       words with a claim about ImageNet's label errors. */
    const capped = RUN2.map((a) => capArgumentBeats(a));
    const result = sourceBeats(capped, { topic: RUN2_TOPIC, cueProvider: { getCues: () => null } });
    const searched = result.sourcingTrace.filter((t) => t.outcome === "no-tape");
    expect(searched).toHaveLength(23);
    expect(result.tapeRelevance).toHaveLength(0);
    for (const trace of searched) {
      /* Every one of them stops before the tape itself: either no episode
         cleared the title-token bar, or the taxonomy gate emptied the field, or
         the episode that did clear it has no transcript body in this checkout.
         None reaches `no-anchor`/`window-overlap`, the two gates that mean tier
         2 got as far as what was actually said. */
      expect(["title-tokens", "lineage", "no-body"]).toContain(trace.tier2!.gate);
    }
  });
});

/* WS-H (docs/curation/generation-fix-plan-2026-09-09.md; findings F-06, F-49).
   Tier 2 chooses its candidate episode by what the archive SAYS, not by what
   its titles are called. Everything after the choice — `resolveAnchorFromCues`,
   the anchored-window test, the lineage gate, the cut to cue boundaries, the
   audio-source check — is unchanged, and the cases below are as interested in
   what the new search still REFUSES as in what it now finds. */

describe("sourceBeats — WS-H: tier 2 matches transcript text, not titles (F-06)", () => {
  /** An episode whose title says nothing about anything — exactly the case the
   * title bar cannot admit and 63 of 63 *Practical AI* bodies are made of. */
  const untitledEpisode: TranscriptDigestEntry = {
    show_id: "practical-ai",
    show_title: "Practical AI",
    guid: "pa-172",
    title: "Episode 172",
    cues: 5,
    feed_duration_sec: 3600,
    enclosure_url: "https://cdn.example/pa-172.mp3"
  };

  const labelCues: TranscriptCue[] = [
    { text: "welcome back to the show today we are talking about benchmarks", start_sec: 70, end_sec: 100 },
    { text: "the labels in that benchmark were wrong more often than anyone admitted", start_sec: 100, end_sec: 108 },
    { text: "an audit found thousands of mislabelled validation images across the whole benchmark", start_sec: 108, end_sec: 120 },
    { text: "and those wrong labels put a ceiling on the accuracy anyone could report", start_sec: 120, end_sec: 132 },
    { text: "we will come back to that after the break", start_sec: 132, end_sec: 150 }
  ];

  const labelClaim =
    "An audit found thousands of mislabelled validation images across the whole benchmark, and those wrong labels put a ceiling on the accuracy anyone could report.";

  /** A body source over cues held in memory — the same contract
   * `FileTranscriptCueProvider` implements, so the REAL index does the ranking
   * in these cases rather than a stub that could agree with the code by
   * accident. `cache: false`: nothing here should touch a disk cache. */
  function textIndexOver(archive: TranscriptDigestEntry[], cuesByGuid: Record<string, TranscriptCue[]>): TranscriptTextIndex {
    const bodies: TranscriptBodySource = {
      getCues: (entry) => cuesByGuid[entry.guid] ?? null,
      bodyStat: (entry) => (cuesByGuid[entry.guid] ? { mtimeMs: 1, size: 1 } : null)
    };
    return new FileTranscriptTextIndex({ archive, bodies, cache: false });
  }

  function beatFor(claim: string): DeepenedAct[] {
    return [makeDeepenedAct({ slots: [{ title: "Labels", beats: [{ claim, exploration: false, kind: "account" }] }] }, "WSH")];
  }

  it("mints tape from an episode whose TITLE shares nothing with the claim, because its transcript says it", () => {
    const result = sourceBeats(beatFor(labelClaim), {
      segmentPool: [],
      transcriptArchive: [untitledEpisode],
      cueProvider: { getCues: () => labelCues },
      textIndex: textIndexOver([untitledEpisode], { "pa-172": labelCues }),
      topic: "engineering/ai-robotics"
    });

    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing === "tape") {
      expect(beat.tape.tier).toBe(2);
      expect(beat.tape.itemId).toContain("practical-ai");
      /* The minted times are CUE boundaries (F-24(c)) and they are the WINDOW's
         boundaries: the three cues that carry the claim, 100-132. F-62 is why
         it stops there — this case used to end at 150, because symmetric
         padding took "we will come back to that after the break" to reach
         `MIN_TAPE_SEGMENT_SEC`, and that is 18 s of tape about nothing. */
      expect(beat.tape.startSec).toBe(100);
      expect(beat.tape.endSec).toBe(132);
      expect(beat.tape.endSec - beat.tape.startSec).toBeGreaterThanOrEqual(ABSOLUTE_MIN_TAPE_SEGMENT_SEC);
      expect(beat.tape.endSec - beat.tape.startSec).toBeLessThanOrEqual(MAX_TAPE_SEGMENT_SEC);
      /* The anchors are the tape's own words at those two cues, not the
         claim's (F-61) — asserted verbatim below in the anchor cases. */
      expect(labelCues.some((c) => c.text.includes(beat.tape.startAnchor))).toBe(true);
      expect(labelCues.some((c) => c.text.includes(beat.tape.endAnchor))).toBe(true);
    }
    expect(result.newSegments).toHaveLength(1);
    expect(result.newSegments[0]!.startSec).toBe(100);
    expect(result.newSegments[0]!.endSec).toBe(132);
  });

  it("is the whole difference: the same beat, the same archive, no text index — no tape, refused on the title bar", () => {
    /* F-06 stated as a test. The episode, the transcript and the claim are
       identical; the only thing removed is the search over the text. This is
       what every one of run 2's 23 searching beats hit. */
    const result = sourceBeats(beatFor(labelClaim), {
      segmentPool: [],
      transcriptArchive: [untitledEpisode],
      cueProvider: { getCues: () => labelCues },
      topic: "engineering/ai-robotics"
    });
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("title-tokens");
    expect(tier2.bestEpisodeTitle).toBeNull();
    expect(tier2.foundBy).toBeUndefined();
  });

  /** The same episode, saying a few of the claim's words in a row and then
   * talking about something else — F-24's own shape: an anchor exists, and the
   * tape around it is not about the claim. */
  const offTopicCues: TranscriptCue[] = [
    { text: "we looked at images across the whole benchmark last spring", start_sec: 10, end_sec: 20 },
    { text: "anyway that was a completely different conversation about hiring", start_sec: 20, end_sec: 30 },
    { text: "and we never went back to it", start_sec: 30, end_sec: 40 }
  ];

  it("records the BM25 score, the rank and how many episodes it opened on the row that decided", () => {
    const result = sourceBeats(beatFor(labelClaim), {
      segmentPool: [],
      transcriptArchive: [untitledEpisode],
      cueProvider: { getCues: () => offTopicCues },
      textIndex: textIndexOver([untitledEpisode], { "pa-172": offTopicCues }),
      topic: "engineering/ai-robotics"
    });

    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("window-overlap");
    expect(tier2.foundBy).toBe("text-index");
    expect(tier2.textScore).toBeGreaterThan(0);
    expect(tier2.textRank).toBe(0);
    expect(tier2.textMatchedTerms).toBeGreaterThanOrEqual(3);
    expect(tier2.candidatesConsidered).toBe(1);
    /* And the title bar's own number is still reported — as a number, not as a
       verdict: the episode is called "Episode 172" and scores zero. */
    expect(tier2.score).toBe(0);
  });

  it("says `text-index:no-candidate` when the search ran and the archive had nothing worth opening", () => {
    const result = sourceBeats(beatFor("Tokamak plasma confinement obeys the Lawson criterion."), {
      segmentPool: [],
      transcriptArchive: [untitledEpisode],
      cueProvider: { getCues: () => labelCues },
      textIndex: textIndexOver([untitledEpisode], { "pa-172": labelCues }),
      topic: "engineering/ai-robotics"
    });
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("text-index:no-candidate");
    expect(tier2.candidatesConsidered).toBe(0);
  });

  it("reports the candidate that got FURTHEST, not the one the text ranked first", () => {
    /* Eight candidates a beat cannot use are one story; one candidate whose
       tape was reached and refused is another, and it is the one a person tunes
       a threshold against (F-49). */
    const absent: TranscriptDigestEntry = { ...untitledEpisode, guid: "pa-999", title: "Episode 999" };
    const cuesByGuid: Record<string, TranscriptCue[]> = {
      // The top-ranked episode says the most about the claim...
      "pa-999": [...offTopicCues, { text: "mislabelled validation images benchmark labels accuracy audit ceiling", start_sec: 40, end_sec: 50 }],
      "pa-172": offTopicCues
    };
    const result = sourceBeats(beatFor(labelClaim), {
      segmentPool: [],
      transcriptArchive: [absent, untitledEpisode],
      // ...but its BODY is not on this machine, so only the second can be opened.
      cueProvider: { getCues: (entry) => (entry.guid === "pa-172" ? offTopicCues : null) },
      textIndex: textIndexOver([absent, untitledEpisode], cuesByGuid),
      topic: "engineering/ai-robotics"
    });

    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.candidatesConsidered).toBe(2);
    expect(tier2.gate).toBe("window-overlap");
    expect(tier2.bestEpisodeTitle).toBe("Episode 172");
  });

  it("refuses the run-1 Chernobyl-for-Hyatt anchor even when the text search offers the episode", () => {
    /* F-23/F-24 with the new search in front of them. The *Causality* Chernobyl
       episode shares the trade's vocabulary with a Hyatt Regency claim — design,
       load, review, failure — so the text index will happily rank it. What
       refuses it is what has always refused it once the tape is actually read:
       the claim's own words are not spoken there. */
    const chernobyl: TranscriptDigestEntry = {
      show_id: "causality-engineered-network",
      show_title: "Causality — Engineered Network",
      guid: "c22",
      title: "22: Chernobyl",
      cues: 4,
      feed_duration_sec: 3600
    };
    const chernobylCues: TranscriptCue[] = [
      { text: "the reactor design carried a positive void coefficient at low power", start_sec: 10, end_sec: 20 },
      { text: "the test procedure had been reviewed and then changed on the night", start_sec: 20, end_sec: 30 },
      { text: "the load on the turbines was never the thing that failed here", start_sec: 30, end_sec: 40 },
      { text: "and the review that would have caught it was never run", start_sec: 40, end_sec: 50 }
    ];
    const hyattClaim =
      "The original, unrevised design was already carrying roughly half the load required by the Kansas City building code, so a full structural review would likely have found the walkway inadequate.";

    const result = sourceBeats(beatFor(hyattClaim), {
      segmentPool: [],
      transcriptArchive: [chernobyl],
      cueProvider: { getCues: () => chernobylCues },
      textIndex: textIndexOver([chernobyl], { c22: chernobylCues })
    });

    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    expect(result.newSegments).toHaveLength(0);
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.foundBy).toBe("text-index");
    /* AFTER F-61 THIS REFUSAL HAS TO COME FROM THE RELEVANCE FLOOR, not from
       the verbatim rule that used to carry it — the rule is gone, and if the
       floor did not hold, this is the beat that would take Chernobyl tape. */
    expect(tier2.gate).toBe("window-overlap");
    expect(tier2.windowWeightedShare!).toBeLessThan(TIER2_WINDOW_MIN_SHARE);
    expect(tapeWindowIsRelevant(selectTapeWindow(hyattClaim, chernobylCues))).toBe(false);
  });

  it("refuses the run-1 griddle anchor: a food-history episode is off-lineage however much vocabulary it shares", () => {
    /* F-29. The text index is given the episode and the topic gate never lets
       the search reach it — the gate runs BEFORE any body is opened, which is
       also why a 1,700-episode archive is cheap to search. */
    const griddle: TranscriptDigestEntry = {
      show_id: "british-food-history",
      show_title: "British Food History",
      guid: "bfh-griddle",
      title: "The griddle and the bakestone",
      cues: 3,
      feed_duration_sec: 2764
    };
    const griddleCues: TranscriptCue[] = [
      { text: "most british cooking happened at an open hearth until the mid nineteenth century", start_sec: 10, end_sec: 20 },
      { text: "people would have had one hearth and would have used it for everything", start_sec: 20, end_sec: 30 },
      { text: "the load of the bakestone was carried on an iron bar", start_sec: 30, end_sec: 40 }
    ];
    const kansasCity =
      "The original, unrevised design was already carrying roughly half the load required by the Kansas City building code, so a full structural review would likely have found the walkway inadequate even without the phone-call revision.";

    const result = sourceBeats(beatFor(kansasCity), {
      segmentPool: [],
      transcriptArchive: [griddle],
      cueProvider: { getCues: () => griddleCues },
      textIndex: textIndexOver([griddle], { "bfh-griddle": griddleCues }),
      topic: "engineering/disasters"
    });

    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    expect(result.newSegments).toHaveLength(0);
    expect(result.sourcingTrace[0]!.tier2!.gate).not.toBe("window-overlap");
    /* Belt and braces, and the half F-61 has to answer for: with the topic gate
       taken away entirely, the tape itself still fails the relevance floor. */
    expect(tapeWindowIsRelevant(selectTapeWindow(kansasCity, griddleCues))).toBe(false);
  });

  it("refuses the run-2 San Bruno anchor for an AI latency beat: the lineage gate runs before the text search", () => {
    /* Run 2's Greg Linden beat found `causality-engineered-network--35-san-bruno`
       at full score in tier 1 and was refused by the taxonomy gate. Tier 2's new
       search must not be a way around that gate. */
    const sanBruno: TranscriptDigestEntry = {
      show_id: "causality-engineered-network",
      show_title: "Causality — Engineered Network",
      guid: "c35",
      title: "35: San Bruno",
      cues: 3,
      feed_duration_sec: 3600
    };
    const sanBrunoCues: TranscriptCue[] = [
      { text: "the latency between the alarm and the response was measured in minutes", start_sec: 10, end_sec: 20 },
      { text: "every hundred milliseconds of delay cost them something measurable", start_sec: 20, end_sec: 30 },
      { text: "the record of the test was never filed with the regulator", start_sec: 30, end_sec: 40 }
    ];
    const latencyClaim =
      "Greg Linden's internal test at Amazon showed that every hundred milliseconds of delay cost them something measurable in revenue.";

    const result = sourceBeats(beatFor(latencyClaim), {
      segmentPool: [],
      transcriptArchive: [sanBruno],
      cueProvider: { getCues: () => sanBrunoCues },
      textIndex: textIndexOver([sanBruno], { c35: sanBrunoCues }),
      topic: "engineering/ai-robotics"
    });

    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    expect(result.newSegments).toHaveLength(0);
    expect(["lineage", "text-index:no-candidate"]).toContain(result.sourcingTrace[0]!.tier2!.gate);
    /* SAID PLAINLY, BECAUSE IT MATTERS: the relevance floor would NOT save this
       one. The San Bruno tape quotes the claim almost word for word — "every
       hundred milliseconds of delay cost them something measurable" is as true
       of a gas pipeline alarm as of a web store — so the window is relevant and
       the LINEAGE gate is the only thing between this beat and wrong tape.
       Asserting that here is what stops someone reordering the two gates. */
    expect(tapeWindowIsRelevant(selectTapeWindow(latencyClaim, sanBrunoCues))).toBe(true);
  });
});

/* F-61 and F-62 (docs/curation/generation-run-2026-09-09.md).

   F-61: tier 2 used to decide BOTH questions with one rule — a run of four or
   more of the claim's own words spoken verbatim. Claims are written prose and
   tape is speech, so with WS-H's text search in front of it, all 23 searching
   beats of run 2 reached real transcripts and every one died at `no-anchor`.
   The window now answers relevance and the tape's own words answer the
   boundaries.

   F-62: what reaches segment length grows toward the claim, never
   symmetrically. */

/** A real `FileTranscriptTextIndex` over cues held in memory, so these cases
 * exercise the index that ranks candidates and supplies idf rather than a stub
 * that could agree with the code by accident. */
function memoryTextIndex(entries: TranscriptDigestEntry[], cuesByGuid: Record<string, TranscriptCue[]>): TranscriptTextIndex {
  const bodies: TranscriptBodySource = {
    getCues: (e) => cuesByGuid[e.guid] ?? null,
    bodyStat: (e) => (cuesByGuid[e.guid] ? { mtimeMs: 1, size: 1 } : null)
  };
  return new FileTranscriptTextIndex({ archive: entries, bodies, cache: false });
}

describe("sourceBeats — F-61: the window decides relevance, the tape's own words anchor it", () => {
  const entry: TranscriptDigestEntry = {
    show_id: "practical-ai",
    show_title: "Practical AI",
    guid: "pa-gearbox",
    title: "Episode 204",
    cues: 6,
    feed_duration_sec: 3600,
    enclosure_url: "https://cdn.example/pa-204.mp3"
  };

  /** Written prose, the way a deepen stage writes a claim. */
  const claim =
    "Wind turbine gearboxes fail early because their bearings take torque reversals that the original load case never modelled.";

  /** Speech, the way a person says the same thing — sharing the claim's
   * vocabulary and none of its phrasing. */
  const cues: TranscriptCue[] = [
    { text: "welcome back to the programme this week we are at a test facility in denmark", start_sec: 0, end_sec: 20 },
    { text: "so the gearboxes are where the trouble starts and it is the bearings that give up first", start_sec: 20, end_sec: 40 },
    { text: "you get reversals of torque that nobody put into the design envelope back then", start_sec: 40, end_sec: 60 },
    { text: "and so they fail early years before the load case said they would", start_sec: 60, end_sec: 80 },
    { text: "anyway we will be back after a word from the people who pay for this show", start_sec: 80, end_sec: 100 }
  ];

  function beatFor(c: string): DeepenedAct[] {
    return [makeDeepenedAct({ slots: [{ title: "Gearboxes", beats: [{ claim: c, exploration: false, kind: "account" }] }] }, "F61")];
  }

  /** The rule F-61 removed, implemented here so the case can assert it is gone:
   * a contiguous run of `n` of the CLAIM's own significant words, spoken
   * verbatim in the tape. */
  function hasVerbatimClaimRun(claimText: string, tape: TranscriptCue[], n = 4): boolean {
    const words = canonicalizeForAnchorMatch(claimText)
      .split(" ")
      .filter((w) => w.length > 2);
    const spoken = ` ${tape.map((c) => canonicalizeForAnchorMatch(c.text)).join(" ")} `;
    for (let i = 0; i + n <= words.length; i++) {
      if (spoken.includes(` ${words.slice(i, i + n).join(" ")} `)) return true;
    }
    return false;
  }

  function mint() {
    return sourceBeats(beatFor(claim), {
      segmentPool: [],
      transcriptArchive: [entry],
      cueProvider: { getCues: () => cues },
      textIndex: memoryTextIndex([entry], { "pa-gearbox": cues }),
      topic: "engineering/ai-robotics"
    });
  }

  it("mints tape for a claim whose words are nowhere spoken verbatim — which is the whole of F-61", () => {
    /* The premise, asserted rather than asserted-in-prose: the old rule had
       nothing to find here. Every one of run 2's 23 searching beats was this
       case against a real episode.

       MUTATION THAT KILLS THIS: put the verbatim-run requirement back in front
       of the window search. The beat goes back to narration. */
    expect(hasVerbatimClaimRun(claim, cues)).toBe(false);

    const beat = allSourcedBeats(mint().acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing === "tape") expect(beat.tape.tier).toBe(2);
  });

  it("chooses the stretch that carries the claim, and leaves the welcome and the ad read out of it", () => {
    const segment = mint().newSegments[0]!;
    expect(segment.startSec).toBe(20);
    expect(segment.endSec).toBe(80);
  });

  it("quotes both anchors from the tape at the span's own boundaries, verbatim", () => {
    /* ADR-0007's requirement, and the reason a claim-derived anchor is useless:
       the listener's copy is searched for these words, so they have to be words
       somebody actually said. `merge-segments.mjs` canonicalises both sides
       before comparing, so canonical-verbatim is verbatim to the validator. */
    const segment = mint().newSegments[0]!;
    const boundaryCues = cues.filter((c) => c.start_sec === segment.startSec || c.end_sec === segment.endSec);
    expect(boundaryCues).toHaveLength(2);
    expect(canonicalizeForAnchorMatch(boundaryCues[0]!.text)).toContain(segment.startAnchor);
    expect(canonicalizeForAnchorMatch(boundaryCues[1]!.text)).toContain(segment.endAnchor);
    for (const anchor of [segment.startAnchor, segment.endAnchor]) {
      const words = anchor.split(" ");
      expect(words.length).toBeGreaterThanOrEqual(4);
      expect(words.length).toBeLessThanOrEqual(8);
      /* Not a run of function words: an anchor of "and so it was that we" is
         findable in every minute of every episode and locates nothing. */
      expect(new Set(tokenizeForSourcing(anchor)).size).toBeGreaterThanOrEqual(2);
    }
    expect(segment.startAnchor).not.toBe(segment.endAnchor);
  });

  it("refuses the same episode for a claim it only mentions in passing", () => {
    /* One cue says "torque" and nothing else in the episode is about the claim:
       three content words in the best window, and 0.2 of the claim. */
    const passing =
      "Torque reversals in a helicopter tail rotor gearbox are counted differently from the ones a wind turbine sees, and the certification basis is a different document entirely.";
    const result = sourceBeats(beatFor(passing), {
      segmentPool: [],
      transcriptArchive: [entry],
      cueProvider: { getCues: () => cues },
      textIndex: memoryTextIndex([entry], { "pa-gearbox": cues }),
      topic: "engineering/ai-robotics"
    });
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("window-overlap");
    expect(tier2.windowWeightedShare!).toBeLessThan(TIER2_WINDOW_MIN_SHARE);
  });

  it("records on the trace which of the claim's words the tape said, and where", () => {
    const passing = "Torque reversals in a helicopter tail rotor gearbox are counted under a different certification basis entirely.";
    const tier2 = sourceBeats(beatFor(passing), {
      segmentPool: [],
      transcriptArchive: [entry],
      cueProvider: { getCues: () => cues },
      textIndex: memoryTextIndex([entry], { "pa-gearbox": cues }),
      topic: "engineering/ai-robotics"
    }).sourcingTrace[0]!.tier2!;
    expect(tier2.windowMatchedTerms).toContain("torque");
    expect(tier2.windowStartSec).toBeGreaterThanOrEqual(0);
    expect(tier2.windowEndSec).toBeGreaterThan(tier2.windowStartSec!);
  });

  it("skips a filler opening and quotes the phrase with the most content words at the boundary", () => {
    /* Speech starts mid-thought. An anchor of "so anyway you know i mean" is
       findable in half the archive and locates nothing, so the mint looks a few
       words further into the cue for something a person could search for
       (ADR-0007's locate step SEARCHES the listener's transcript; the anchor
       does not have to begin exactly at the cut). */
    const fillerOpening: TranscriptCue[] = [
      { text: "and it was the same as it was the gearboxes and the bearings and the torque reversals were to blame", start_sec: 20, end_sec: 50 },
      { text: "you get reversals of torque that nobody put into the design envelope back then", start_sec: 50, end_sec: 80 },
      { text: "and so they fail early years before the load case said they would", start_sec: 80, end_sec: 110 }
    ];
    const segment = sourceBeats(beatFor(claim), {
      segmentPool: [],
      transcriptArchive: [entry],
      cueProvider: { getCues: () => fillerOpening },
      textIndex: memoryTextIndex([entry], { "pa-gearbox": fillerOpening }),
      topic: "engineering/ai-robotics"
    }).newSegments[0]!;
    expect(canonicalizeForAnchorMatch(fillerOpening[0]!.text)).toContain(segment.startAnchor);
    /* "as it was the gearboxes and the bearings" is what taking the FIRST
       phrase that clears the content-word bar produces. Two words further in
       there is a phrase carrying twice as much. */
    expect(segment.startAnchor).toBe("gearboxes and the bearings and the torque reversals");
    expect(new Set(tokenizeForSourcing(segment.startAnchor)).size).toBeGreaterThanOrEqual(4);
  });

  it("one rare word is not enough: three of the claim's rare words have to be spoken", () => {
    /* The false positive this rule exists for, measured in the offline replay:
       a claim about agents failing on an upstream change matched a passage
       about de-duplicating test fixtures at 0.37 of the claim — over the share
       floor — because the guest said "upstream" once, in a different sense.
       Rare words carry the share, so the COUNT is measured on rare words too:
       two rules that fail differently. */
    const oneRareWord: TranscriptCue[] = [
      { text: "the gearboxes were fine and the system was fine and the model was fine that year", start_sec: 0, end_sec: 30 },
      { text: "so the system and the model and the data all behaved for once", start_sec: 30, end_sec: 60 }
    ];
    const commonEverywhere: TranscriptCue[] = [
      { text: "the system and the model and the data are the three things we always talk about", start_sec: 0, end_sec: 30 },
      { text: "the model the system the data every episode of this show", start_sec: 30, end_sec: 60 }
    ];
    const other: TranscriptDigestEntry = { ...entry, guid: "pa-other", title: "Episode 205" };
    const cuesByGuid: Record<string, TranscriptCue[]> = { "pa-gearbox": oneRareWord, "pa-other": commonEverywhere };
    const result = sourceBeats(beatFor("Wind turbine gearboxes fail when the system, the model and the data disagree about the load."), {
      segmentPool: [],
      transcriptArchive: [entry, other],
      cueProvider: { getCues: (e) => cuesByGuid[e.guid] ?? null },
      textIndex: memoryTextIndex([entry, other], cuesByGuid),
      topic: "engineering/ai-robotics"
    });
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("window-overlap");
    expect(tier2.windowDistinctiveTerms!.length).toBeLessThan(3);
  });

  it("weights a rare word above the trade's shared vocabulary when an index supplies idf", () => {
    /* F-33's problem in F-61's setting: inside one subject every episode shares
       the trade's words, so a plain count cannot tell the episode that is ABOUT
       a claim from the one that merely talks shop. The corpus knows which words
       are rare, and the floor is measured in those. */
    const shopTalk: TranscriptCue[] = [
      { text: "so the model and the data and the system all have to be in production together", start_sec: 0, end_sec: 30 },
      { text: "and the model performance in production is a system question not a model question", start_sec: 30, end_sec: 60 },
      { text: "the data the model the system all of it in production", start_sec: 60, end_sec: 90 }
    ];
    const aboutIt: TranscriptCue[] = [
      { text: "the imagenet validation labels were audited and thousands of them were simply wrong", start_sec: 0, end_sec: 30 },
      { text: "so the imagenet ceiling everybody was measuring against was a mislabelling ceiling", start_sec: 30, end_sec: 60 },
      { text: "and the audit put the label error rate at about six percent of the validation set", start_sec: 60, end_sec: 90 }
    ];
    const shopTalkEntry: TranscriptDigestEntry = { ...entry, guid: "pa-shop", title: "Episode 301" };
    const aboutItEntry: TranscriptDigestEntry = { ...entry, guid: "pa-about", title: "Episode 302" };
    const archive = [shopTalkEntry, aboutItEntry];
    const cuesByGuid: Record<string, TranscriptCue[]> = { "pa-shop": shopTalk, "pa-about": aboutIt };
    const imagenetClaim =
      "An imagenet audit found the validation labels were wrong often enough to put a ceiling on the accuracy any production model could report.";

    const result = sourceBeats(beatFor(imagenetClaim), {
      segmentPool: [],
      transcriptArchive: archive,
      cueProvider: { getCues: (e) => cuesByGuid[e.guid] ?? null },
      textIndex: memoryTextIndex(archive, cuesByGuid),
      topic: "engineering/ai-robotics"
    });

    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing === "tape") expect(beat.tape.itemId).toContain("302");
  });
});

describe("sourceBeats — F-62: a short window grows toward the claim, never symmetrically", () => {
  const entry: TranscriptDigestEntry = {
    show_id: "practical-ai",
    show_title: "Practical AI",
    guid: "pa-grow",
    title: "Episode 208",
    cues: 5,
    feed_duration_sec: 3600,
    enclosure_url: "https://cdn.example/pa-208.mp3"
  };
  const claim = "The retraining calendar slipped a week and the recommender started serving stale inventory to everybody.";

  function run(cues: TranscriptCue[]) {
    return sourceBeats(
      [makeDeepenedAct({ slots: [{ title: "Retraining", beats: [{ claim, exploration: false, kind: "account" }] }] }, "F62")],
      {
        segmentPool: [],
        transcriptArchive: [entry],
        cueProvider: { getCues: () => cues },
        textIndex: memoryTextIndex([entry], { "pa-grow": cues }),
        topic: "engineering/ai-robotics"
      }
    );
  }

  /** The window is 32 s; reaching `MIN_TAPE_SEGMENT_SEC` needs one more cue,
   * and only one of the two neighbours is about the claim. */
  const leadInIsOffClaim: TranscriptCue[] = [
    { text: "before the break we were arguing about which coffee machine the office should buy", start_sec: 0, end_sec: 26 },
    { text: "so the retraining calendar slipped by about a week that time", start_sec: 26, end_sec: 42 },
    { text: "and the recommender was serving stale inventory to everybody for days", start_sec: 42, end_sec: 58 },
    { text: "the stale rows came out of the same inventory feed the calendar drives", start_sec: 58, end_sec: 76 },
    { text: "right after this we have got a completely different guest and a new subject", start_sec: 76, end_sec: 100 }
  ];

  it("takes the neighbouring cue that shares the claim's words and leaves the off-claim lead-in alone", () => {
    /* F-62 exactly: run 2's one successful mint reached `MIN_TAPE_SEGMENT_SEC`
       by padding symmetrically, and this archive's cues average ~28 s, so the
       pad was half a minute of unrelated tape at the front. Here the lead-in is
       the office coffee machine and the next cue explains the claim. */
    const segment = run(leadInIsOffClaim).newSegments[0]!;
    expect(segment.startSec).toBe(26);
    expect(segment.endSec).toBe(76);
    expect(segment.endSec - segment.startSec).toBeGreaterThanOrEqual(MIN_TAPE_SEGMENT_SEC);
  });

  it("grows backwards instead when that is the side the claim is on", () => {
    const tailIsOffClaim: TranscriptCue[] = [
      { text: "the inventory feed that the retraining calendar drives had gone stale on the friday", start_sec: 0, end_sec: 26 },
      { text: "so the retraining calendar slipped by about a week that time", start_sec: 26, end_sec: 42 },
      { text: "and the recommender was serving stale rows to everybody for days", start_sec: 42, end_sec: 58 },
      { text: "anyway that is enough of that let us talk about the conference next month", start_sec: 58, end_sec: 90 }
    ];
    const segment = run(tailIsOffClaim).newSegments[0]!;
    expect(segment.startSec).toBe(0);
    expect(segment.endSec).toBe(58);
  });

  it("prefers a short segment to an off-claim one when neither neighbour says anything", () => {
    const bothOffClaim: TranscriptCue[] = [
      { text: "before the break we were arguing about which coffee machine the office should buy", start_sec: 0, end_sec: 26 },
      { text: "so the retraining calendar slipped by about a week that time", start_sec: 26, end_sec: 42 },
      { text: "and the recommender was serving stale inventory to everybody for days", start_sec: 42, end_sec: 58 },
      { text: "right after this we have got a completely different guest and a new subject", start_sec: 58, end_sec: 100 }
    ];
    const segment = run(bothOffClaim).newSegments[0]!;
    expect(segment.startSec).toBe(26);
    expect(segment.endSec).toBe(58);
    /* Under `MIN_TAPE_SEGMENT_SEC` and deliberately so: 32 s of the claim beats
       58 s that opens on the office coffee machine. */
    expect(segment.endSec - segment.startSec).toBeLessThan(MIN_TAPE_SEGMENT_SEC);
    expect(segment.endSec - segment.startSec).toBeGreaterThanOrEqual(ABSOLUTE_MIN_TAPE_SEGMENT_SEC);
  });

  it("takes an off-claim cue only when the span would otherwise be too short to play", () => {
    /* The one case that overrides the rule above: below
       `ABSOLUTE_MIN_TAPE_SEGMENT_SEC` a span is not a piece of tape a listener
       can be dropped into, and a short off-claim tail is the lesser harm. */
    const tinyWindow: TranscriptCue[] = [
      { text: "before the break we were arguing about which coffee machine the office should buy", start_sec: 0, end_sec: 26 },
      { text: "the retraining calendar slipped a week and the recommender served stale inventory", start_sec: 26, end_sec: 44 },
      { text: "right after this we have got a completely different guest and a new subject", start_sec: 44, end_sec: 60 }
    ];
    const segment = run(tinyWindow).newSegments[0]!;
    expect(segment.startSec).toBe(26);
    expect(segment.endSec).toBe(60);
    expect(segment.endSec - segment.startSec).toBeGreaterThanOrEqual(ABSOLUTE_MIN_TAPE_SEGMENT_SEC);
  });

  it("never pads symmetrically: the two sides are asked, not alternated", () => {
    /* The mutation this exists to kill is the code that was here — grow one cue
       back, then one cue forward, until long enough. It would take the coffee
       machine in the first case above and the conference in the second, and
       both assertions would fail. Stated once, as a property over both. */
    expect(run(leadInIsOffClaim).newSegments[0]!.startSec).toBe(26);
    const cutBackwards = run([
      { text: "the inventory feed that the retraining calendar drives had gone stale on the friday", start_sec: 0, end_sec: 26 },
      { text: "so the retraining calendar slipped by about a week that time", start_sec: 26, end_sec: 42 },
      { text: "and the recommender was serving stale rows to everybody for days", start_sec: 42, end_sec: 58 },
      { text: "anyway that is enough of that let us talk about the conference next month", start_sec: 58, end_sec: 90 }
    ]).newSegments[0]!;
    expect(cutBackwards.endSec).toBe(58);
  });
});

/* WS-L (F-63): §4.3 now writes some beats FROM a stretch of tape and says which,
   and §4.5 opens that episode first. What these cases pin is that the seed
   changes the ORDER of the search and nothing else — no threshold moves, and a
   seed whose tape will not carry the claim is refused exactly as loudly as an
   unseeded beat is. */
describe("sourceBeats — WS-L: a seeded beat opens its own episode first (F-63)", () => {
  const seededEpisode: TranscriptDigestEntry = {
    show_id: "practical-ai",
    show_title: "Practical AI",
    guid: "pa-900",
    title: "Episode 900",
    cues: 5,
    feed_duration_sec: 3600,
    enclosure_url: "https://cdn.example/pa-900.mp3"
  };
  /** The same conversation, said twice as often — so BM25 ranks it FIRST and it
   * wins any beat the seed does not steer. */
  const decoyEpisode: TranscriptDigestEntry = { ...seededEpisode, guid: "pa-901", title: "Episode 901" };

  const labelCues: TranscriptCue[] = [
    { text: "welcome back to the show today we are talking about benchmarks", start_sec: 70, end_sec: 100 },
    { text: "the labels in that benchmark were wrong more often than anyone admitted", start_sec: 100, end_sec: 108 },
    { text: "an audit found thousands of mislabelled validation images across the whole benchmark", start_sec: 108, end_sec: 120 },
    { text: "and those wrong labels put a ceiling on the accuracy anyone could report", start_sec: 120, end_sec: 132 },
    { text: "we will come back to that after the break", start_sec: 132, end_sec: 150 }
  ];
  const louderCues: TranscriptCue[] = [
    ...labelCues,
    { text: "an audit found thousands of mislabelled validation images across the whole benchmark", start_sec: 150, end_sec: 175 },
    { text: "and those wrong labels put a ceiling on the accuracy anyone could report", start_sec: 175, end_sec: 200 }
  ];
  const claim =
    "An audit found thousands of mislabelled validation images across the whole benchmark, and those wrong labels put a ceiling on the accuracy anyone could report.";

  const cuesByGuid: Record<string, TranscriptCue[]> = { "pa-900": labelCues, "pa-901": louderCues };
  const archive = [seededEpisode, decoyEpisode];

  function indexOver(entries: TranscriptDigestEntry[], cues: Record<string, TranscriptCue[]>): TranscriptTextIndex {
    const bodies: TranscriptBodySource = {
      getCues: (entry) => cues[entry.guid] ?? null,
      bodyStat: (entry) => (cues[entry.guid] ? { mtimeMs: 1, size: 1 } : null)
    };
    return new FileTranscriptTextIndex({ archive: entries, bodies, cache: false });
  }

  function actFor(seed?: { episodeId: string; startSec: number; endSec: number }): DeepenedAct[] {
    return [
      makeDeepenedAct(
        { slots: [{ title: "Labels", beats: [{ claim, exploration: false, kind: "account", ...(seed ? { seed } : {}) }] }] },
        "WSL"
      )
    ];
  }

  function run(seed?: { episodeId: string; startSec: number; endSec: number }) {
    return sourceBeats(actFor(seed), {
      segmentPool: [],
      transcriptArchive: archive,
      cueProvider: { getCues: (entry) => cuesByGuid[entry.guid] ?? null },
      textIndex: indexOver(archive, cuesByGuid),
      topic: "engineering/ai-robotics"
    });
  }

  it("takes the seeded episode even though the text index ranks another one first", () => {
    /* Without a seed the louder episode wins, which is the correct answer when
       nothing upstream knows better. With one, the episode the spine actually
       wrote the beat from is the one the listener hears. */
    const unseeded = allSourcedBeats(run().acts)[0]!;
    expect(unseeded.sourcing).toBe("tape");
    if (unseeded.sourcing === "tape") expect(unseeded.tape.itemId).toBe("practical-ai--episode-901");

    const result = run({ episodeId: "practical-ai--episode-900", startSec: 100, endSec: 132 });
    const beat = allSourcedBeats(result.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing === "tape") {
      expect(beat.tape.itemId).toBe("practical-ai--episode-900");
      expect(beat.tape.tier).toBe(2);
    }
    /* And the run can be asked whether reading the tape first is what produced
       the tape, without anyone re-deriving the join by hand. */
    const row = result.tapeRelevance[0]!;
    expect(row.seededEpisode).toBe("practical-ai--episode-900");
    expect(row.seedWindowWon).toBe(true);
  });

  it("accepts a seed that names the episode by guid as well as by item id", () => {
    const result = run({ episodeId: "pa-900", startSec: 100, endSec: 132 });
    const beat = allSourcedBeats(result.acts)[0]!;
    if (beat.sourcing === "tape") expect(beat.tape.itemId).toBe("practical-ai--episode-900");
    expect(result.tapeRelevance[0]!.seedWindowWon).toBe(true);
  });

  it("does not lower the floor for a seeded episode whose tape is not about the claim", () => {
    /* The rule the whole workstream stands on: a seed is a hint about where to
       look, never a permission to use what is found there. This episode says a
       few of the claim's words and then talks about something else — F-24's own
       shape — and the relevance floor refuses it exactly as it would unseeded. */
    const offClaim: TranscriptCue[] = [
      { text: "we looked at images across the whole benchmark last spring", start_sec: 10, end_sec: 40 },
      { text: "and then we spent an hour on procurement paperwork and hiring", start_sec: 40, end_sec: 90 },
      { text: "which is not what any of you came here for but there it is", start_sec: 90, end_sec: 140 }
    ];
    const only = [seededEpisode];
    const result = sourceBeats(actFor({ episodeId: "practical-ai--episode-900", startSec: 10, endSec: 90 }), {
      segmentPool: [],
      transcriptArchive: only,
      cueProvider: { getCues: () => offClaim },
      textIndex: indexOver(only, { "pa-900": offClaim }),
      topic: "engineering/ai-robotics"
    });

    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("window-overlap");
    expect(tier2.windowWeightedShare).toBeLessThan(TIER2_WINDOW_MIN_SHARE);
    /* And the trace says the seed was tried and lost, which is the row a person
       tuning this reads first. */
    expect(tier2.seededEpisode).toBe("practical-ai--episode-900");
    expect(tier2.seedWindowWon).toBe(false);
  });

  it("passes over a seeded episode the topic gate refuses, instead of admitting it", () => {
    /* A seed cannot smuggle an off-branch show past the lineage gate (F-23/F-29)
       — the seeded candidate is never even added when `isUsable` says no. */
    const result = sourceBeats(actFor({ episodeId: "practical-ai--episode-900", startSec: 100, endSec: 132 }), {
      segmentPool: [],
      transcriptArchive: archive,
      cueProvider: { getCues: (entry) => cuesByGuid[entry.guid] ?? null },
      textIndex: indexOver(archive, cuesByGuid),
      topic: "food/grilling-bbq"
    });
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    expect(result.newSegments).toHaveLength(0);
    /* Nothing was opened at all: the gate emptied the candidate list before the
       walk, so what the trace reports is the search that found nothing to open,
       and the seed is recorded as tried and lost like any other. */
    expect(result.sourcingTrace[0]!.tier2!.gate).toBe("text-index:no-candidate");
    expect(result.sourcingTrace[0]!.tier2!.seededEpisode).toBe("practical-ai--episode-900");
    expect(result.sourcingTrace[0]!.tier2!.seedWindowWon).toBe(false);
  });

  it("changes nothing for a beat with no seed", () => {
    const seedless = run();
    const beat = allSourcedBeats(seedless.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    expect(seedless.tapeRelevance[0]!.seededEpisode).toBeNull();
    expect(seedless.tapeRelevance[0]!.seedWindowWon).toBe(false);
  });
});

describe("sourceBeats — F-68: the seeded beat's OWN window is the first stretch of tape asked for", () => {
  /* WS-L put the seeded EPISODE at the front of the walk and then searched the
     whole hour of it, so the stretch §4.3 actually quoted — the stretch the
     claim's words came out of — competed with every other minute of the same
     episode and lost whenever another minute scored higher. Here that is exactly
     what happens: the seeded stretch says three of the claim's five words, and a
     later stretch of the SAME episode says all five. */
  const entry: TranscriptDigestEntry = {
    show_id: "practical-ai",
    show_title: "Practical AI",
    guid: "pa-950",
    title: "Episode 950",
    cues: 7,
    feed_duration_sec: 3600,
    enclosure_url: "https://cdn.example/pa-950.mp3"
  };

  /** Five content words after `tokenizeForSourcing`: gearboxes, fail, bearings,
   * torque, reversals. */
  const claim = "Gearboxes fail because bearings take torque reversals.";

  const cues: TranscriptCue[] = [
    { text: "welcome back to the programme we are in denmark this week", start_sec: 0, end_sec: 30 },
    /* 100-160s: the stretch §4.3 quoted and wrote the claim from. Three of the
       five words — 0.6 of the claim, three distinctive terms, over the floor. */
    { text: "the gearboxes here are the part that gives everybody trouble", start_sec: 100, end_sec: 120 },
    { text: "and it is the bearings that give up first on almost all of them", start_sec: 120, end_sec: 140 },
    { text: "you get a lot of torque coming back the other direction as well", start_sec: 140, end_sec: 160 },
    /* 300-360s: a summary later in the same hour that happens to say all five. */
    { text: "the gearboxes fail well before the design life says they should", start_sec: 300, end_sec: 320 },
    { text: "bearings crack under torque that keeps switching direction on them", start_sec: 320, end_sec: 340 },
    { text: "and those reversals were never in the original load case at all", start_sec: 340, end_sec: 360 }
  ];

  function actFor(seed?: { episodeId: string; startSec: number; endSec: number }): DeepenedAct[] {
    return [
      makeDeepenedAct(
        { slots: [{ title: "Gearboxes", beats: [{ claim, exploration: false, kind: "account", ...(seed ? { seed } : {}) }] }] },
        "F68"
      )
    ];
  }

  function run(seed?: { episodeId: string; startSec: number; endSec: number }) {
    return sourceBeats(actFor(seed), {
      segmentPool: [],
      transcriptArchive: [entry],
      cueProvider: { getCues: () => cues },
      textIndex: memoryTextIndex([entry], { "pa-950": cues }),
      topic: "engineering/ai-robotics"
    });
  }

  it("cuts the seeded stretch, not the higher-scoring one later in the same episode", () => {
    /* Ran it — red: drop the `within` branch in sourceBeats.ts (go back to a
       bare `selectTapeWindow(claim, cues, { idf })`) and this mints 300-360
       instead, which is the F-68 behaviour. */
    const seeded = run({ episodeId: "pa-950", startSec: 100, endSec: 160 });
    expect(allSourcedBeats(seeded.acts)[0]!.sourcing).toBe("tape");
    const segment = seeded.newSegments[0]!;
    expect(segment.startSec).toBe(100);
    expect(segment.endSec).toBe(160);
  });

  it("is the whole difference: the same claim, the same episode, no seed — the louder stretch wins", () => {
    const unseeded = run();
    expect(allSourcedBeats(unseeded.acts)[0]!.sourcing).toBe("tape");
    expect(unseeded.newSegments[0]!.startSec).toBe(300);
    expect(unseeded.newSegments[0]!.endSec).toBe(360);
  });

  it("falls back to the whole-episode search when the seeded window itself does not clear the floor", () => {
    /* A PREFERENCE, NOT A PERMISSION — the same rule as the seeded episode. The
       welcome at 0-30s says none of the claim's words, so the seed's own window
       is refused by the unchanged floor and the search runs as it always did. */
    const elsewhere = run({ episodeId: "pa-950", startSec: 0, endSec: 30 });
    expect(allSourcedBeats(elsewhere.acts)[0]!.sourcing).toBe("tape");
    expect(elsewhere.newSegments[0]!.startSec).toBe(300);
  });

  it("still refuses a seeded window the tape does not carry at all, rather than lowering the floor for it", () => {
    /* The seeded stretch here is the ad read, and nothing else in the episode is
       about the claim either: the confined window loses, the whole-episode
       window loses, and the beat is narration with the same gate as ever. */
    const offClaim: TranscriptCue[] = [
      { text: "welcome back to the programme we are in denmark this week", start_sec: 0, end_sec: 40 },
      { text: "and now a word from the people who pay for this show every month", start_sec: 40, end_sec: 90 },
      { text: "right where were we before all of that nonsense started", start_sec: 90, end_sec: 140 }
    ];
    const result = sourceBeats(actFor({ episodeId: "pa-950", startSec: 40, endSec: 90 }), {
      segmentPool: [],
      transcriptArchive: [entry],
      cueProvider: { getCues: () => offClaim },
      textIndex: memoryTextIndex([entry], { "pa-950": offClaim }),
      topic: "engineering/ai-robotics"
    });
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("window-overlap");
    expect(tier2.seededEpisode).toBe("pa-950");
    expect(tier2.seedWindowWon).toBe(false);
  });

  it("credits F-72's floor with nothing when the seeded window clears the rare-word count too", () => {
    /* The counterpart to the F-72 cases below, on this fixture, where the seed
       window says three of the claim's five words and every one of them is
       rare (one episode, so every term weighs the same): the searching floor
       would have taken this window unaided, so `seedFloor` is absent and the
       run log's count stays a count of DECISIONS. */
    const seeded = run({ episodeId: "pa-950", startSec: 100, endSec: 160 });
    const row = seeded.tapeRelevance[0]!;
    expect(row.seedWindowWon).toBe(true);
    expect(row.seedFloor).toBeUndefined();
  });
});

/* F-72: THE SEED IS THE RELEVANCE JUDGEMENT; THE RARE-WORD FLOOR GUARDS SEARCH.
 *
 * Run 2 attempt 5 was the first run with the seeded claims frozen (F-68) and the
 * seed's own window asked first (also F-68) — and the spine's own wording still
 * failed the tier-2 floor on the spine's own window. Not on share: on the
 * rare-word count. Three of the seven refused seeds, from that run's trace rows
 * (`gate: window-overlap`, `seedWindowWon: false`):
 *
 *   0.846  ['internship']           the old advice that an internship in your
 *                                   junior or senior year was enough
 *   0.717  ['validation','uipath']   third-party validation as the thing an
 *                                   AI assurance standard actually sells
 *   0.534  ['lingering','layered']   the infrastructure side against the
 *                                   developer-side problem on top of it
 *
 * Eleven tape beats of 32 where 14 were available. The rare-word count exists to
 * refuse a window a whole-ARCHIVE search landed on because it shares the trade's
 * everyday vocabulary with the claim — run 1's Chernobyl, griddle and San Bruno
 * anchors, which are re-run above and stay refused. For a SEEDED beat that
 * question is already answered: §4.3 read that exact window and wrote the claim
 * out of it. So the seed window is judged on share alone, and nothing else is.
 */
describe("tapeWindowIsRelevant — F-72: two floors, and one share bar neither waives", () => {
  /** A window with nothing in it but the two numbers the floors read. The cue
   * indices and seconds are inert here — this is a test of the verdict, not of
   * the search that produces one. */
  function windowWith(weightedShare: number, distinctiveTerms: string[]): TapeWindow {
    return {
      firstCue: 0,
      lastCue: 2,
      startSec: 100,
      endSec: 160,
      matchedTerms: distinctiveTerms,
      distinctiveTerms,
      claimTermCount: 12,
      share: distinctiveTerms.length / 12,
      weightedShare,
      score: weightedShare
    };
  }

  it("takes a seed window on share alone: 0.846 of the claim carried by one rare word", () => {
    /* Ran it — red: change `if (floor === "seed-window") return true;` in
       `tapeWindowIsRelevant` back to falling through to the rare-word count and
       the first expectation flips to false. */
    const internship = windowWith(0.846, ["internship"]);
    expect(tapeWindowIsRelevant(internship, "seed-window")).toBe(true);
    expect(seedFloorDecided(internship)).toBe(true);
  });

  it("refuses the very same window when a SEARCH is what found it", () => {
    /* The regression this rule must not buy back. `distinctiveTerms.length` is
       one against `TIER2_WINDOW_MIN_TERMS`, and for a searching window that is
       still the end of it however high the share climbs. */
    const internship = windowWith(0.846, ["internship"]);
    expect(TIER2_WINDOW_MIN_TERMS).toBe(3);
    expect(tapeWindowIsRelevant(internship, "archive-search")).toBe(false);
  });

  it("defaults to the searching floor, so no caller reaches the seed floor by omitting an argument", () => {
    const uipath = windowWith(0.717, ["validation", "uipath"]);
    expect(tapeWindowIsRelevant(uipath)).toBe(false);
    expect(tapeWindowIsRelevant(uipath, "seed-window")).toBe(true);
  });

  it("never waives the share floor for a seed: run 2's 0.217 row stays refused", () => {
    /* "One engineer describes taking about two weeks to get through the shift to
       agentic coding" — a genuinely loose claim, and refusing it is right. The
       seed says where to look, not that the tape there carries the claim. */
    const loose = windowWith(0.217, ["weeks"]);
    expect(tapeWindowIsRelevant(loose, "seed-window")).toBe(false);
    expect(tapeWindowIsRelevant(loose, "archive-search")).toBe(false);
    expect(seedFloorDecided(loose)).toBe(false);
  });

  it("claims no credit for a seed window the searching floor would have taken anyway", () => {
    const both = windowWith(0.6, ["gearboxes", "bearings", "torque"]);
    expect(tapeWindowIsRelevant(both, "seed-window")).toBe(true);
    expect(tapeWindowIsRelevant(both, "archive-search")).toBe(true);
    expect(seedFloorDecided(both)).toBe(false);
  });

  it("is a verdict about a window, so no window is no", () => {
    expect(tapeWindowIsRelevant(null, "seed-window")).toBe(false);
    expect(tapeWindowIsRelevant(null)).toBe(false);
    expect(seedFloorDecided(null)).toBe(false);
  });
});

describe("sourceBeats — F-72: the seeded beat's own window is judged on share alone", () => {
  /* THE 0.717 ROW IN MINIATURE. Six episodes of one show, so `validation` is rare
     (1 of 6 bodies) while the claim's other four words are what every episode of
     the trade says (6 of 6). With BM25's own idf that ratio puts `validation` at
     weight one and each of the others at about a twentieth of it — so the stretch
     the spine quoted speaks ~0.88 of what the claim is distinctively about while
     clearing exactly ONE of the three rare words a searching window must. */
  const seeded: TranscriptDigestEntry = {
    show_id: "practical-ai",
    show_title: "Practical AI",
    guid: "pa-960",
    title: "Episode 960",
    cues: 4,
    feed_duration_sec: 3600,
    enclosure_url: "https://cdn.example/pa-960.mp3"
  };

  /** Five content words after `tokenizeForSourcing`: assurance, standards, sell,
   * validation, vendors. */
  const claim = "Assurance standards sell validation to vendors.";

  const cues: TranscriptCue[] = [
    { text: "welcome back to the programme this week we are talking shop with a friend", start_sec: 0, end_sec: 40 },
    /* 40-70 s: the trade's everyday words and not one rare one — the seed window
       of the share-floor case below. */
    { text: "the vendors we hear from all sell against the same standards every quarter", start_sec: 40, end_sec: 70 },
    /* 100-160 s: the stretch §4.3 quoted and wrote the claim out of. */
    { text: "the whole assurance conversation turns on one thing in the end", start_sec: 100, end_sec: 130 },
    { text: "third party validation is the thing everybody is really buying here", start_sec: 130, end_sec: 160 }
  ];

  /** Five more episodes of the same show that talk about vendors, standards and
   * selling and never once say `validation`. They are what MAKES those four words
   * common and that one rare — the fixture's mechanism is the corpus, not a
   * hand-set weight. */
  const filler: TranscriptDigestEntry[] = [1, 2, 3, 4, 5].map((n) => ({ ...seeded, guid: `pa-96${n}`, title: `Episode 96${n}` }));
  const fillerCues: TranscriptCue[] = [
    { text: "the vendors on this panel all sell to the same buyers every single year", start_sec: 0, end_sec: 40 },
    { text: "and the standards they point at are the ones their own lawyers wrote", start_sec: 40, end_sec: 80 },
    { text: "assurance is the word everybody reaches for when the room goes quiet", start_sec: 80, end_sec: 120 }
  ];

  const archive = [seeded, ...filler];
  const cuesByGuid: Record<string, TranscriptCue[]> = { "pa-960": cues };
  for (const f of filler) cuesByGuid[f.guid] = fillerCues;

  type Seed = { episodeId: string; startSec: number; endSec: number };

  function actFor(seed?: Seed): DeepenedAct[] {
    return [
      makeDeepenedAct(
        { slots: [{ title: "Assurance", beats: [{ claim, exploration: false, kind: "account", ...(seed ? { seed } : {}) }] }] },
        "F72"
      )
    ];
  }

  function run(seed?: Seed) {
    return sourceBeats(actFor(seed), {
      segmentPool: [],
      transcriptArchive: archive,
      cueProvider: { getCues: (entry) => cuesByGuid[entry.guid] ?? null },
      textIndex: memoryTextIndex(archive, cuesByGuid),
      topic: "engineering/ai-robotics"
    });
  }

  it("mints the seeded stretch on share alone, and says so in the trace", () => {
    /* Ran it — red: change `seedWindowClears` in `sourceBeats.ts` back to
       `tapeWindowIsRelevant(seedWindow)` and this beat is narration, because no
       window of this episode can ever hold three rare words. */
    const result = run({ episodeId: "pa-960", startSec: 100, endSec: 160 });
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("tape");
    const segment = result.newSegments[0]!;
    expect(segment.startSec).toBe(100);
    expect(segment.endSec).toBe(160);
    /* The anchors are still the tape's own words at the window's edges (F-61):
       the floor decides relevance, and nothing about how a window is cut. */
    expect(cues[2]!.text).toContain(segment.startAnchor);
    expect(cues[3]!.text).toContain(segment.endAnchor);
    const row = result.tapeRelevance[0]!;
    expect(row.tier).toBe(2);
    expect(row.seededEpisode).toBe("pa-960");
    expect(row.seedWindowWon).toBe(true);
    expect(row.seedFloor).toBe("share-only");
  });

  it("still refuses that window when a SEARCH is what found it — share was never the problem", () => {
    /* The same claim, the same episode, the same passage, no seed. The whole
       archive is searched, the window it lands on is about as good as a window
       can be on share, and the rare-word count refuses it — which is exactly
       what keeps run 1's Chernobyl/griddle/San Bruno anchors out. */
    const unseeded = run();
    expect(allSourcedBeats(unseeded.acts)[0]!.sourcing).toBe("narration");
    expect(unseeded.newSegments).toHaveLength(0);
    const tier2 = unseeded.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("window-overlap");
    expect(tier2.bestEpisodeTitle).toBe("Episode 960");
    expect(tier2.windowWeightedShare!).toBeGreaterThanOrEqual(TIER2_WINDOW_MIN_SHARE);
    expect(tier2.windowDistinctiveTerms).toEqual(["validation"]);
    /* No seed, so neither seed field is claimed. */
    expect(tier2.seededEpisode).toBeUndefined();
    expect(tier2.seedFloor).toBeUndefined();
  });

  it("does not lower the share floor for a seed: a seeded window of everyday words is refused", () => {
    /* Run 2's 0.217 case. The seed points at 40-70 s, which says three of the
       claim's five words and not one of the rare ones, so its weighted share is
       nowhere near the floor; §4.5 falls back to the whole-episode search, which
       is refused for lacking rare words like any other search result, and the
       beat is narration with the same gate as ever. */
    const result = run({ episodeId: "pa-960", startSec: 40, endSec: 70 });
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("window-overlap");
    expect(tier2.seededEpisode).toBe("pa-960");
    expect(tier2.seedWindowWon).toBe(false);
    expect(tier2.seedFloor).toBeUndefined();
  });

  it("does not let a seed reach into another episode: a seeded window elsewhere in the archive is refused", () => {
    /* The seed names a filler episode, whose tape says the trade's words and
       nothing rare. A seed is a hint about WHERE to look; the tape there still
       has to carry the claim. */
    const result = run({ episodeId: "pa-961", startSec: 0, endSec: 120 });
    expect(allSourcedBeats(result.acts)[0]!.sourcing).toBe("narration");
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(tier2.gate).toBe("window-overlap");
    expect(tier2.seedWindowWon).toBe(false);
    expect(tier2.seedFloor).toBeUndefined();
  });

  it("keeps a share-only acceptance inside the M3/M4 ledger (F-70), like any other placement", () => {
    /* A share-only acceptance is a PLACEMENT, so it must move the ledgers — or
       F-70's fix would have a hole shaped exactly like F-72's rule. Two beats
       naming the same window: the first takes it, and the second is refused
       because the Foray then holds one tape segment and M4's cap is one. */
    const twoBeats: DeepenedAct[] = [
      makeDeepenedAct(
        {
          slots: [
            {
              title: "Assurance",
              beats: [
                { claim, exploration: false, kind: "account", seed: { episodeId: "pa-960", startSec: 100, endSec: 160 } },
                { claim, exploration: false, kind: "account", seed: { episodeId: "pa-960", startSec: 100, endSec: 160 } }
              ]
            }
          ]
        },
        "F72M4"
      )
    ];
    const result = sourceBeats(twoBeats, {
      segmentPool: [],
      transcriptArchive: archive,
      cueProvider: { getCues: (entry) => cuesByGuid[entry.guid] ?? null },
      textIndex: memoryTextIndex(archive, cuesByGuid),
      topic: "engineering/ai-robotics"
    });
    expect(result.newSegments).toHaveLength(1);
    expect(result.tapeRelevance).toHaveLength(1);
    expect(m4SegmentCapFor(1)).toBe(1);
    const beats = allSourcedBeats(result.acts);
    expect(beats[0]!.sourcing).toBe("tape");
    /* The two beats are the same claim with the same seed, so the ONLY thing
       that differs between them is what the first one wrote into the ledger.
       (The reported gate is the furthest one across the whole walk, which for
       the second beat is a filler episode's `window-overlap` — `m4-share`
       refuses pa-960 and the walk carries on past it, exactly as tier 1's
       does.) */
    expect(beats[1]!.sourcing).toBe("narration");
  });
});

/* F-70: TIER 2 KEEPS THE SAME FORAY-WIDE LEDGER TIER 1 DOES.
 *
 * Run 2 attempt 4b was the first run to finish a Foray with tape in it, and
 * `tools/foray/check-forays.mjs` refused it on both assembly rules at once:
 *
 *   M3 FAIL: practical-ai--federated-learning-in-production-part-2#953 plays at
 *   953.015 s of "..." after a later segment from the same episode
 *   M4 FAIL: "practical-ai--federated-learning-in-production-part-2" is 40.0 %
 *   of segments and 42.2 % of runtime, over the 25 % cap
 *
 * Two seeded beats of one slot named one episode — windows at 1925-2020 s and
 * 1019-1101 s — and tier 2, which MINTS a segment rather than picking one out of
 * the pool, consulted none of the ledgers tier 1 has kept since the pipeline's
 * first end-to-end run. The cases below are that Foray in miniature. */
describe("sourceBeats — F-70: tier 2 obeys M3 and M4, the same ledger tier 1 keeps", () => {
  const seeded: TranscriptDigestEntry = {
    show_id: "practical-ai",
    show_title: "Practical AI",
    guid: "pa-950",
    title: "Episode 950",
    cues: 7,
    feed_duration_sec: 3600,
    enclosure_url: "https://cdn.example/pa-950.mp3"
  };

  /** A SECOND episode carrying the same claim — so "refused" can be told from
   * "gave up". Tier 1 falls through to the next candidate rather than dropping
   * to narration, and tier 2 must do the same. */
  const other: TranscriptDigestEntry = { ...seeded, guid: "pa-951", title: "Episode 951", enclosure_url: "https://cdn.example/pa-951.mp3" };

  /** Five content words: gearboxes, fail, bearings, torque, reversals. */
  const claim = "Gearboxes fail because bearings take torque reversals.";

  /* Two stretches of ONE episode, both about the claim — 100-160 s says three
     of its five words, 300-360 s says all five. Exactly the shape of the two
     *Practical AI* windows that broke M3. */
  const cues: TranscriptCue[] = [
    { text: "welcome back to the programme we are in denmark this week", start_sec: 0, end_sec: 30 },
    { text: "the gearboxes here are the part that gives everybody trouble", start_sec: 100, end_sec: 120 },
    { text: "and it is the bearings that give up first on almost all of them", start_sec: 120, end_sec: 140 },
    { text: "you get a lot of torque coming back the other direction as well", start_sec: 140, end_sec: 160 },
    { text: "the gearboxes fail well before the design life says they should", start_sec: 300, end_sec: 320 },
    { text: "bearings crack under torque that keeps switching direction on them", start_sec: 320, end_sec: 340 },
    { text: "and those reversals were never in the original load case at all", start_sec: 340, end_sec: 360 }
  ];

  type Seed = { episodeId: string; startSec: number; endSec: number };
  const gearboxBeat = (seed: Seed) => ({ claim, exploration: false, kind: "account" as const, seed });

  /* SEVEN TIER-1 BEATS TO FILL THE FORAY FIRST, for the M3 case only. M4's cap
     is a share of the tape PLACED (`m4SegmentCapFor`), so an episode is not
     allowed a second segment until the Foray holds eight — which means that in
     a two-beat Foray the M4 gate would refuse the second window before the
     order rule was ever asked, and the M3 case would pass for the wrong reason.
     These seven come from seven DIFFERENT episodes through tier 1, which shares
     the same ledger, so by the time the two gearbox beats are sourced the Foray
     is full enough for M4 to permit a second *Practical AI* window and M3 to be
     the only thing that can refuse it. */
  const fillerClaim = "The Lawson criterion is a statement about tokamak plasma confinement.";
  const fillerPool = (): SegmentRecord[] =>
    Array.from({ length: 7 }, (_v, i) => ({
      ...fixtureSegmentPool()[0]!,
      id: `filler-${i}#100`,
      item_id: `filler-${i}`,
      start_sec: 100,
      end_sec: 220
    }));

  function run(beats: Array<{ claim: string; exploration: boolean; kind?: "account"; seed?: Seed }>, archive: TranscriptDigestEntry[]) {
    const cuesByGuid: Record<string, TranscriptCue[]> = { "pa-950": cues, "pa-951": cues };
    return sourceBeats([makeDeepenedAct({ slots: [{ title: "Gearboxes", beats }] }, "F70")], {
      segmentPool: fillerPool(),
      transcriptArchive: archive,
      cueProvider: { getCues: (e) => cuesByGuid[e.guid] ?? null },
      textIndex: memoryTextIndex(archive, cuesByGuid)
    });
  }

  const fillerBeats = (n: number) => Array.from({ length: n }, () => ({ claim: fillerClaim, exploration: false }));

  it("refuses a second window that sits EARLIER in an episode already joined later (M3)", () => {
    /* CHECKER ERROR THIS PREVENTS: the M3 FAIL quoted above, verbatim from run
       2 attempt 4b. The first gearbox beat is seeded to 300-360 s; the second is
       seeded to 100-160 s, which is real tape about the claim and which tier 2
       would have minted and played after it.

       MUTATION THAT KILLS THIS: delete the `m3OrderAllows` check from the
       tier-2 walk in `sourceBeats.ts`. The second beat then mints
       `practical-ai--episode-950#100` and plays it after #300 — the finding
       itself. Ran it — red. */
    const result = run(
      [...fillerBeats(7), gearboxBeat({ episodeId: "pa-950", startSec: 300, endSec: 360 }), gearboxBeat({ episodeId: "pa-950", startSec: 100, endSec: 160 })],
      [seeded]
    );
    const beats = allSourcedBeats(result.acts);
    expect(beats[7]!.sourcing).toBe("tape");
    expect(result.newSegments).toHaveLength(1);
    expect(result.newSegments[0]!.startSec).toBe(300);

    expect(beats[8]!.sourcing).toBe("narration");
    const trace = result.sourcingTrace.find((t) => t.beatIndex === 8)!;
    expect(trace.tier2!.gate).toBe("m3-order");
    /* The trace still says WHICH episode and WHICH window was refused — the
       whole point of naming a gate rather than reporting "no tape". */
    expect(trace.tier2!.bestEpisodeTitle).toBe("Episode 950");
    expect(trace.tier2!.windowStartSec).toBe(100);
    expect(trace.tier2!.seededEpisode).toBe("pa-950");
  });

  it("falls through to the next candidate episode rather than dropping to narration (M3)", () => {
    /* Tier 1's rule, applied to tier 2: an assembly veto sends the search on to
       the next candidate, it does not end it. Same two beats, same seeds — the
       only difference is that the archive now holds a second episode saying the
       same thing, and the refused beat takes ITS tape. */
    const result = run(
      [...fillerBeats(7), gearboxBeat({ episodeId: "pa-950", startSec: 300, endSec: 360 }), gearboxBeat({ episodeId: "pa-950", startSec: 100, endSec: 160 })],
      [seeded, other]
    );
    const beats = allSourcedBeats(result.acts);
    expect(beats[8]!.sourcing).toBe("tape");
    if (beats[8]!.sourcing === "tape") {
      expect(beats[8]!.tape.itemId).toBe("practical-ai--episode-951");
    }
    expect(result.newSegments).toHaveLength(2);
  });

  it("refuses a second window from an episode already at its M4 share (M4)", () => {
    /* CHECKER ERROR THIS PREVENTS: the M4 FAIL quoted above — one episode at
       40 % of a five-segment Foray. Both beats are seeded to the same episode
       and the windows are in ASCENDING order this time, so M3 has nothing to
       say: the share cap is the only thing that can refuse the second, and with
       two segments placed a second from one episode would be 100 % of them.

       MUTATION THAT KILLS THIS: delete the `m4ShareAllows` check from the
       tier-2 walk. The second beat mints a second *Practical AI* segment and
       the Foray is 2/2 from one episode. Ran it — red. */
    const result = run(
      [gearboxBeat({ episodeId: "pa-950", startSec: 100, endSec: 160 }), gearboxBeat({ episodeId: "pa-950", startSec: 300, endSec: 360 })],
      [seeded]
    );
    const beats = allSourcedBeats(result.acts);
    expect(beats[0]!.sourcing).toBe("tape");
    expect(result.newSegments).toHaveLength(1);
    expect(result.newSegments[0]!.startSec).toBe(100);

    expect(beats[1]!.sourcing).toBe("narration");
    const trace = result.sourcingTrace.find((t) => t.beatIndex === 1)!;
    expect(trace.tier2!.gate).toBe("m4-share");
    /* Refused BEFORE the body is opened, so there is no window to report — the
       answer is the same for every window of an episode already at its share. */
    expect(trace.tier2!.windowStartSec).toBeUndefined();
  });

  it("falls through to another episode when the seeded one is at its M4 share", () => {
    const result = run(
      [gearboxBeat({ episodeId: "pa-950", startSec: 100, endSec: 160 }), gearboxBeat({ episodeId: "pa-950", startSec: 300, endSec: 360 })],
      [seeded, other]
    );
    const beats = allSourcedBeats(result.acts);
    expect(beats[1]!.sourcing).toBe("tape");
    if (beats[1]!.sourcing === "tape") {
      expect(beats[1]!.tape.itemId).toBe("practical-ai--episode-951");
    }
  });

  it("names the new gates in the slot summary and the narration reason, like any other refusal", () => {
    /* `summarizeSourcing` is what a person watching a run reads, and a beat
       refused by an assembly rule must not be reported as "no tape found
       anywhere" — the tape was found, this Foray could not take it. */
    const result = run(
      [gearboxBeat({ episodeId: "pa-950", startSec: 100, endSec: 160 }), gearboxBeat({ episodeId: "pa-950", startSec: 300, endSec: 360 })],
      [seeded]
    );
    expect(summarizeSourcing(result).some((line) => line.includes("top reason: tier2:m4-share"))).toBe(true);

    const narrated = allSourcedBeats(result.acts)[1]!;
    expect(narrated.sourcing).toBe("narration");
    if (narrated.sourcing === "narration") {
      expect(narrated.narration.reason).toContain("quarter of its segments");
    }
    /* And the transcription queue does not ask for work that would not help:
       the archive already had the tape. */
    expect(result.transcriptionQueueCandidates[0]!.reason).toContain("Nothing to transcribe");
  });
});

/* THE OFFLINE HALF: the same code against the REAL transcript archive, which
   lives in `data-local/` and is on the generation machine only. These cases
   skip themselves, loudly and by name, anywhere else — a checkout without the
   bodies is exactly the checkout `NullTranscriptTextIndex` is the default for,
   and a green tick there must not be read as evidence about tape.

   WHAT "ANYWHERE ELSE" MEANS, AFTER THIS BROKE (2026-09-09). The guard used to
   be `existsSync(<data-local>/transcripts/normalized)` — the DIRECTORY. On the
   generation machine that directory was emptied while its 63 *Practical AI*
   `.vtt` bodies stayed in `raw/`, so the guard said "the archive is here", the
   cue provider returned `null` for every episode, the text index rebuilt to
   nothing, and both cases below failed deterministically with no hint of why.
   The guard now asks the only question that means anything — can a body
   actually be read for any episode in the archive — and answers it against the
   normalised bodies first (what production reads) and the raw ones second (what
   the normaliser is built from; see `helpers/rawVttCueProvider.ts`). */
describe("sourceBeats — WS-H/F-61 offline: the real archive on the generation machine", () => {
  /** A worktree has no `data-local/` of its own; point this at the checkout
   * that holds the archive to run these cases from one. */
  const LOCAL_TRANSCRIPTS = process.env.FORAY_LOCAL_TRANSCRIPTS ?? join(__dirname, "..", "..", "data-local", "transcripts");
  const NORMALIZED_ROOT = join(LOCAL_TRANSCRIPTS, "normalized");
  const RAW_ROOT = join(LOCAL_TRANSCRIPTS, "raw");
  const ARCHIVE = loadTranscriptArchive();
  const RUN2_ACTS: DeepenedAct[] = (
    JSON.parse(readFileSync(join(__dirname, "fixtures", "run2-deepen-2026-09-09.json"), "utf8")) as { acts: DeepenedAct[] }
  ).acts;
  const SKIP_REASON =
    `no transcript body for any archived episode under ${LOCAL_TRANSCRIPTS} ` +
    `(normalized/ or raw/) — tier 2 degrades to the title path here, which is what CI tests above`;

  /** The real bodies, however this machine happens to hold them, or `null`. */
  function realArchive(): { cueProvider: TranscriptBodySource; textIndex: FileTranscriptTextIndex; kind: string } | null {
    const normalized = new FileTranscriptCueProvider(NORMALIZED_ROOT);
    if (ARCHIVE.some((entry) => normalized.bodyStat(entry) !== null)) {
      /* The production path, cache and all — this is the one whose disk cache
         is worth keeping warm. */
      return { cueProvider: normalized, textIndex: new FileTranscriptTextIndex({ bodies: normalized }), kind: "normalized" };
    }
    const raw = new RawVttCueProvider(RAW_ROOT);
    if (raw.hasAnyBody(ARCHIVE)) {
      /* `cache: false`: an index built from raw bodies must never be written to
         the cache the production path reads. */
      return { cueProvider: raw, textIndex: new FileTranscriptTextIndex({ bodies: raw, cache: false }), kind: "raw" };
    }
    return null;
  }

  /** The archive row a minted item id came from — matched on the id itself,
   * which is `deriveItemId`'s output, so there is no chance of grading one
   * episode's anchors against another episode's tape. */
  function entryFor(itemId: string): TranscriptDigestEntry {
    const entry = ARCHIVE.find((e) => deriveItemId(e) === itemId);
    expect(entry).toBeDefined();
    return entry!;
  }

  /** Every distinct claim content word the cue spoken at `sec` carries. */
  function claimTermsSpokenAt(claim: string, cues: TranscriptCue[], sec: number): number {
    const claimTerms = new Set(tokenizeForSourcing(claim));
    let shared = 0;
    for (const cue of cues) {
      if (sec < cue.start_sec || sec >= cue.end_sec) continue;
      for (const term of new Set(tokenizeForSourcing(cue.text))) if (claimTerms.has(term)) shared += 1;
    }
    return shared;
  }

  it("mints real Practical AI tape for a claim the show actually makes, and refuses it without the index", (ctx) => {
    const real = realArchive();
    if (!real) {
      console.log(`[WS-H] skipping real-archive case: ${SKIP_REASON}`);
      ctx.skip();
      return;
    }
    /* The claim says, in written prose, what *Practical AI* says in speech in
       "AI incidents, audits, and the limits of benchmarks". No title in the
       show shares three content words with it, and — the whole of F-61 — no
       four of its words in a row are spoken anywhere in the episode either. */
    const claim =
      "Aviation treats a crash as a regression test nobody wants to repeat, and the same primitive shows up in food safety and in medical adverse event reporting: a bad thing happens, and the industry records it so that it does not happen again.";
    const spine = [
      makeDeepenedAct({ slots: [{ title: "Incidents", beats: [{ claim, exploration: false, kind: "account" }] }] }, "Incidents")
    ];

    const withIndex = sourceBeats(spine, {
      segmentPool: [],
      cueProvider: real.cueProvider,
      textIndex: real.textIndex,
      topic: "engineering/ai-robotics"
    });
    const beat = allSourcedBeats(withIndex.acts)[0]!;
    expect(beat.sourcing).toBe("tape");
    if (beat.sourcing === "tape") {
      expect(beat.tape.tier).toBe(2);
      expect(beat.tape.itemId).toContain("practical-ai");
      expect(beat.tape.endSec - beat.tape.startSec).toBeGreaterThanOrEqual(ABSOLUTE_MIN_TAPE_SEGMENT_SEC);
      expect(beat.tape.endSec - beat.tape.startSec).toBeLessThanOrEqual(MAX_TAPE_SEGMENT_SEC);

      /* The two things F-61 and F-62 are about, asserted against real tape:
         the anchors are words somebody actually said at those two moments, and
         the span opens on a cue that is about the claim rather than on
         whatever happened to precede it. */
      const cues = real.cueProvider.getCues(entryFor(beat.tape.itemId))!;
      const spokenAt = (sec: number) =>
        cues.filter((c) => c.end_sec > sec - 0.01 && c.start_sec < sec + 0.01).map((c) => canonicalizeForAnchorMatch(c.text));
      expect(spokenAt(beat.tape.startSec).some((t) => t.includes(beat.tape.startAnchor))).toBe(true);
      expect(spokenAt(beat.tape.endSec).some((t) => t.includes(beat.tape.endAnchor))).toBe(true);
      expect(claimTermsSpokenAt(claim, cues, beat.tape.startSec + 0.5)).toBeGreaterThan(0);

      console.log(
        `[F-61] ${real.kind} bodies: ${beat.tape.itemId} ${beat.tape.startSec.toFixed(1)}-${beat.tape.endSec.toFixed(1)} s\n` +
          `       start anchor: "${beat.tape.startAnchor}"\n` +
          `       end anchor  : "${beat.tape.endAnchor}"`
      );
    }

    /* And the same beat, on the same machine, with tier 2 back on titles. */
    const titlesOnly = sourceBeats(spine, { segmentPool: [], cueProvider: real.cueProvider, topic: "engineering/ai-robotics" });
    expect(allSourcedBeats(titlesOnly.acts)[0]!.sourcing).toBe("narration");
  });

  it("replays run 2's own beats: tier 2 reaches the tape, and what refuses a beat is the relevance floor", (ctx) => {
    const real = realArchive();
    if (!real) {
      console.log(`[WS-H] skipping run-2 replay: ${SKIP_REASON}`);
      ctx.skip();
      return;
    }
    /* Run 2's deepen output, the real digests, the real bodies, and the topic
       the resolver SHOULD have produced (`engineering/ai-robotics`; it produced
       `engineering/energy-fusion`, which is F-59's own finding).

       WHAT CHANGED, TWICE. Before WS-H every one of these beats stopped at
       `title-tokens`, one content word short of opening an episode. After
       WS-H they reached real transcripts and every one stopped at `no-anchor`
       — the verbatim-run rule, F-61. Now the deciding gate is the window's
       relevance floor: the search reads what the tape SAYS and refuses it for
       saying something else, which is the only refusal a person can argue
       with. The archive's answer for these particular claims is a fact about
       the catalogue (it holds no episode that mentions ImageNet, Greg Linden
       or "hidden technical debt" at all), not about this module. */
    const result = sourceBeats(RUN2_ACTS, {
      segmentPool: [],
      cueProvider: real.cueProvider,
      textIndex: real.textIndex,
      topic: "engineering/ai-robotics"
    });

    const searched = result.sourcingTrace.filter((t) => t.outcome === "no-tape");
    expect(searched).toHaveLength(6);
    const reachedTheTape = searched.filter((t) => t.tier2 && ["window-overlap", "no-anchor"].includes(t.tier2.gate));
    expect(reachedTheTape.length).toBeGreaterThan(0);
    for (const trace of reachedTheTape) {
      expect(trace.tier2!.bestShowId).toBe("practical-ai");
      expect(trace.tier2!.foundBy).toBe("text-index");
      expect(trace.tier2!.textScore).toBeGreaterThan(0);
      /* The title bar it used to die on is still measured, and still low. */
      expect(trace.tier2!.score).toBeLessThan(trace.tier2!.requiredScore);
      /* And the row now says WHICH of the claim's words the tape said and how
         much of the claim that is — the evidence the floor is set from. */
      expect(Array.isArray(trace.tier2!.windowMatchedTerms)).toBe(true);
      expect(trace.tier2!.windowWeightedShare).toBeLessThan(TIER2_WINDOW_MIN_SHARE);
    }
    console.log(
      `[F-61] run-2 replay (${real.kind} bodies): ${result.tapeRelevance.length} tape / ${searched.length} searched; ` +
        `gates ${[...new Set(searched.map((t) => t.tier2?.gate))].join(", ")}`
    );
  });

  it("every span it mints from the real archive opens on tape that is about the claim (F-62)", (ctx) => {
    const real = realArchive();
    if (!real) {
      console.log(`[F-62] skipping real-archive growth case: ${SKIP_REASON}`);
      ctx.skip();
      return;
    }
    /* F-62 in the form that can be checked against a whole run rather than one
       fixture: whatever the growth rule does to reach segment length, the cue
       the listener lands on has to be about the claim. Symmetric padding could
       not promise this — it took whatever preceded the passage. */
    const claims = [
      "Aviation treats a crash as a regression test nobody wants to repeat, and the same primitive shows up in food safety and in medical adverse event reporting.",
      "Model evaluation has to happen against the traffic a system actually sees, because a benchmark score is a claim about a dataset and not about the world."
    ];
    let minted = 0;
    for (const claim of claims) {
      const result = sourceBeats(
        [makeDeepenedAct({ slots: [{ title: "Tape", beats: [{ claim, exploration: false, kind: "account" }] }] }, "F62real")],
        { segmentPool: [], cueProvider: real.cueProvider, textIndex: real.textIndex, topic: "engineering/ai-robotics" }
      );
      const segment = result.newSegments[0];
      if (!segment) continue;
      minted += 1;
      const cues = real.cueProvider.getCues(entryFor(segment.itemId))!;
      expect(claimTermsSpokenAt(claim, cues, segment.startSec + 0.5)).toBeGreaterThan(0);
      expect(segment.endSec - segment.startSec).toBeGreaterThanOrEqual(ABSOLUTE_MIN_TAPE_SEGMENT_SEC);
    }
    expect(minted).toBeGreaterThan(0);
  });

  it(
    "WS-L: reads the tape into the research map, and a spine seeded from it sources real Practical AI tape (F-63)",
    async (ctx) => {
      const real = realArchive();
      if (!real) {
        console.log(`[WS-L] skipping tape-first spine case: ${SKIP_REASON}`);
        ctx.skip();
        return;
      }
      /* F-63 END TO END, KEYLESS, ON THE PROMPT THAT PRODUCED IT.
         Run 2 asked for "how AI systems really get built and put to work" three
         times and got 0 tape beats of 35 — the last time with WS-H, F-59 and
         F-61 all merged and every account beat reaching real *Practical AI*
         transcripts, refused by the relevance floor because the spine had been
         written from item counts and the archive never says `imagenet` or
         `feature store`. This case runs the same intent through the new §4.2,
         builds a spine from the windows it comes back with (the stub, so this
         is keyless and reproducible), deepens it and sources it. What it proves
         is not that the stub writes good prose — it does not — but that beats
         written FROM the tape are beats the tape will carry, with the F-61
         floor untouched. */
      const fixture = JSON.parse(readFileSync(join(__dirname, "fixtures", "run2-deepen-2026-09-09.json"), "utf8")) as {
        subject: string;
        angle: string;
      };
      const intent: IntentUnderstanding = {
        subject: fixture.subject,
        angle: fixture.angle,
        priorKnowledge: "has heard of machine learning, not of what it takes to keep one running",
        disappointment: "stays at the level of model architectures"
      };
      const guard = new BudgetGuard(new InMemoryCostEventSink(), 10);
      const buildCtx = { userId: "ws-l-offline" };

      const shape = await buildResearchShape(intent, {
        researcher: new StubExternalResearcher(guard),
        ctx: buildCtx,
        /* The production wiring: the same index and cue provider §4.5 sources
           with. The topic is left for the stage to resolve, as `runPipeline`
           leaves it. */
        textIndex: real.textIndex,
        cueProvider: real.cueProvider
      });

      const fromPracticalAi = shape.subtopics.filter((s) => s.tapeWindows.some((w) => w.showTitle.includes("Practical AI")));
      expect(fromPracticalAi.length).toBeGreaterThanOrEqual(3);

      /* Printed, not just asserted: the windows are the evidence a human has to
         read to say whether a spine written from them would be about the
         subject the founder asked for. */
      for (const subtopic of fromPracticalAi.slice(0, 3)) {
        const w = subtopic.tapeWindows[0]!;
        console.log(
          `[WS-L] ${subtopic.label} (${subtopic.tape.itemCount} items) -> ${w.showTitle} / ${w.episodeTitle} ` +
            `${Math.round(w.startSec)}-${Math.round(w.endSec)}s (score ${w.score})\n       "${w.text}"`
        );
      }

      const spine = await buildSpine(intent, shape, "medium", new StubSpineBuilder(guard), buildCtx);
      const seededBeats = spine.acts.flatMap((a) => a.slots.flatMap((s) => s.beats)).filter((b) => b.seed);
      expect(seededBeats.length).toBeGreaterThanOrEqual(SPINE_MIN_SEEDED_BEATS_PER_ACT * spine.acts.length);

      const deepened = await deepenActs(spine, new StubDeepenActBuilder(guard), buildCtx);
      const topic = resolveTopic(`${intent.subject} ${intent.angle}`).resolved;
      const result = sourceBeats(deepened, {
        segmentPool: [],
        cueProvider: real.cueProvider,
        textIndex: real.textIndex,
        topic
      });

      const throughTheSeed = result.tapeRelevance.filter((r) => r.seedWindowWon);
      console.log(
        `[WS-L] ${real.kind} bodies, topic ${topic}: ${result.tapeRelevance.length} tape beats of ` +
          `${result.tapeRelevance.length + result.sourcingTrace.length}, ${throughTheSeed.length} through the seeded episode; ` +
          `first anchors: ${result.newSegments.slice(0, 2).map((s) => `"${s.startAnchor}"`).join(" | ")}`
      );
      /* And, for the seeded beats that did NOT make it, the gate and the share
         that refused them — the evidence this workstream's next threshold
         argument has to be made from. */
      const refusedSeeds = result.sourcingTrace.filter((t) => t.tier2?.seededEpisode);
      console.log(
        `[WS-L] seeded beats refused (${refusedSeeds.length}): ` +
          refusedSeeds.map((t) => `${t.tier2!.gate}@${t.tier2!.windowWeightedShare ?? "-"}`).join(", ")
      );
      expect(throughTheSeed.length).toBeGreaterThanOrEqual(1);
      /* The floor did not move: every one of those beats cleared F-61's window
         test on the tape it was written from. */
      for (const row of throughTheSeed) expect(row.itemId).toBe(row.seededEpisode);
    },
    300000
  );
});

