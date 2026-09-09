import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { sourceBeats, summarizeSourcing, M4_ITEM_SHARE_MAX } from "../src/generation/sourceBeats";
import { capArgumentBeats } from "../src/generation/deepenActs";
import { mintSegmentSource } from "../src/generation/audioSourceLookup";
import { validateSourcing, allSourcedBeats } from "../src/types/tapeSourcing";
import type { DeepenedAct } from "../src/types/spine";
import type { SegmentRecord } from "../src/generation/segmentPoolLookup";
import type { TranscriptDigestEntry, TranscriptCue, TranscriptCueProvider } from "../src/generation/transcriptArchiveLookup";
import { MIN_TAPE_SEGMENT_SEC, MAX_TAPE_SEGMENT_SEC } from "../src/generation/transcriptArchiveLookup";
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
      path.resolve(__dirname, "../src/generation/transcriptArchiveLookup.ts"),
      // The topic gate's catalogue reader, added with WS-C: it reads committed
      // `data/` files and must be held to the same rule as the rest.
      path.resolve(__dirname, "../src/generation/taxonomyFamily.ts")
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
    /* F-24(b): `resolveAnchorFromCues` accepts the first contiguous run of four
       claim words found ANYWHERE in an hour of tape. Here that run ("kansas
       city walkway collapse") is a passing mention in a listener-mail segment,
       and the claim's other content words are forty minutes away — the episode
       contains them, the anchored moment does not.

       MUTATION THAT KILLS THIS: delete the `overlap >= TIER2_WINDOW_OVERLAP_MIN`
       condition. The beat then takes those few seconds of tape. Ran it — red. */
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
    expect(result.transcriptionQueueCandidates[0]!.reason).toMatch(/further claim content words are spoken within/);
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

  it("keeps adding cues either side until the span is a segment-length piece of tape", () => {
    const segment = mint().newSegments[0]!;
    expect(segment.endSec - segment.startSec).toBeGreaterThanOrEqual(MIN_TAPE_SEGMENT_SEC);
    expect(segment.endSec - segment.startSec).toBeLessThanOrEqual(MAX_TAPE_SEGMENT_SEC);
    // Grown either side of the anchor cue (640-650), not only forwards.
    expect(segment.startSec).toBeLessThan(640);
    expect(segment.endSec).toBeGreaterThan(650);
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

  it("reports `window-overlap`, with the anchor's own numbers, when the tape around the anchor is about something else", () => {
    /* F-24 in trace form: the anchor proves the phrase was spoken, the window
       says the tape there is not about the claim, and the row carries both
       counts so the `TIER2_WINDOW_OVERLAP_MIN` bar can be argued from data. */
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
      { text: "and then the great oxidation event happened", start_sec: 10, end_sec: 16 },
      { text: "banded iron formations and the great oxidation", start_sec: 16, end_sec: 22 },
      { text: "which is a completely different subject entirely", start_sec: 22, end_sec: 28 },
      { text: "anyway back to the rocks we were discussing", start_sec: 28, end_sec: 34 }
    ];
    const result = sourceBeats(oneBeat("Banded iron formations and the great oxidation event reshaped atmospheric chemistry worldwide forever."), {
      segmentPool: [],
      transcriptArchive: archive,
      cueProvider: { getCues: () => cues }
    });
    const tier2 = result.sourcingTrace[0]!.tier2!;
    expect(["window-overlap", "no-anchor"]).toContain(tier2.gate);
    if (tier2.gate === "window-overlap") {
      expect(typeof tier2.anchorContentWords).toBe("number");
      expect(typeof tier2.beyondAnchorOverlap).toBe("number");
    }
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
