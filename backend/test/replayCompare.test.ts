import { describe, expect, it } from "vitest";
import {
  claimHash,
  compareReplays,
  GOLD_MAX_STRING,
  parseGold,
  recallAt8,
  REPLAY_FORMAT,
  summarizeReplayBeats,
  type ReplayBeat,
  type ReplayCandidate,
  type ReplayReport,
} from "../src/generation/replayCompare";

/**
 * GV-88 (docs/roadmap/generation-v2.md, W3-15): the pure half of the
 * retrieval replay gate, on SYNTHETIC replays built here beat by beat: the
 * MQ-09 unseeded yield and the dense-only counts computed exactly, the
 * verdict's three cases (pass, fail on a lost tape beat, fail on no gain for
 * the hybrid gate), incomparable replays, and the gold-label schema that keeps
 * claim and transcript text out of the committed label file. No file system,
 * no model.
 */

interface BeatSpec {
  key: string;
  seeded?: boolean;
  argument?: boolean;
  /** Tape: the winner's item, show and via. Absent: narration. */
  tape?: {
    item: string;
    show?: string;
    via?: string;
    seedWon?: boolean;
    segment?: string;
    startSec?: number;
    endSec?: number;
    merged?: boolean;
  };
  candidates?: Array<{ item: string; via?: string; show?: string }>;
  tier2Gate?: string;
  furthestVia?: string;
}

function beat(spec: BeatSpec): ReplayBeat {
  const [a, s, b] = spec.key.split(".").map(Number) as [number, number, number];
  const claim = `synthetic claim ${spec.key}`;
  const candidates: ReplayCandidate[] = (spec.candidates ?? []).map(
    (c, rank) => ({
      showId: c.show ?? "show-a",
      guid: `${c.item}-guid`,
      itemId: c.item,
      rank,
      via: c.via ?? "bm25",
    }),
  );
  const t = spec.tape;
  const searched = !spec.argument;
  return {
    key: spec.key,
    actIndex: a,
    slotIndex: s,
    beatIndex: b,
    claimHash: claimHash(claim),
    claim,
    kind: spec.argument ? "argument" : "account",
    searched,
    seeded: spec.seeded === true,
    sourcing: t ? "tape" : "narration",
    tier: t ? 2 : null,
    gate: t
      ? "placed"
      : spec.argument
        ? "skipped:argument"
        : (spec.tier2Gate ?? "window-overlap"),
    tier1Gate: null,
    tier2Gate: t || spec.argument ? null : (spec.tier2Gate ?? "window-overlap"),
    seedGate: null,
    seedWindowWon: spec.seeded ? (t?.seedWon ?? false) : null,
    candidates,
    winner: t
      ? {
          segmentId: t.segment ?? `${t.item}#100`,
          itemId: t.item,
          tier: 2,
          startSec: t.startSec ?? 100,
          endSec: t.endSec ?? 200,
          showKey: t.show ?? "show-a",
          via: t.via ?? "bm25",
          merged: t.merged === true,
        }
      : null,
    furthestVia: spec.furthestVia ?? null,
  };
}

function replay(specs: BeatSpec[]): ReplayReport {
  const beats = specs.map(beat);
  return {
    format: REPLAY_FORMAT,
    fixture: "synthetic.json",
    topic: null,
    retrieval: { source: "local", mode: "bm25" },
    showShare: "off",
    beats,
    summary: summarizeReplayBeats(beats),
  };
}

/* The base arm: 2 seeded beats (one won its seed), 4 unseeded searching beats
   (2 found tape), 1 argument. */
const BASE: BeatSpec[] = [
  {
    key: "0.0.0",
    seeded: true,
    tape: { item: "ep-1", seedWon: true, via: "seed" },
  },
  { key: "0.0.1", seeded: true },
  {
    key: "0.0.2",
    tape: { item: "ep-2", show: "show-b" },
    candidates: [{ item: "ep-2", show: "show-b" }],
  },
  { key: "0.0.3", tape: { item: "ep-3" }, candidates: [{ item: "ep-3" }] },
  { key: "0.0.4", candidates: [{ item: "ep-9" }] },
  { key: "0.1.0" },
  { key: "0.1.1", argument: true },
];

describe("replayCompare: the summary numbers, exactly", () => {
  it("unseededYield is unseeded beats that found tape over unseeded beats that searched (argument and seeded beats out)", () => {
    /* MUTATION THAT KILLS THIS: count every unseeded beat (the argument too)
       in the denominator, or every searched beat. Ran the first: red (2/5). */
    const s = replay(BASE).summary;
    expect(s).toMatchObject({
      beats: 7,
      searchedBeats: 6,
      tapeBeats: 3,
      seededBeats: 2,
      seedsWon: 1,
      unseededBeats: 4,
      unseededTapeBeats: 2,
      unseededYield: 0.5,
    });
    expect(
      replay([
        { key: "0.0.0", argument: true },
        { key: "0.0.1", seeded: true },
      ]).summary.unseededYield,
    ).toBeNull();
  });

  it("dense-only candidates, wins (not a seed's own window) and window-overlap refusals are counted per beat; show variety counts a merged clip once", () => {
    /* MUTATION THAT KILLS THIS: count a seed-won beat whose winner is
       dense-only as a dense win, or count a refusal whose furthest candidate
       came from bm25. Ran the first: red (3 wins). */
    const s = replay([
      {
        key: "0.0.0",
        tape: {
          item: "ep-d",
          via: "dense",
          show: "show-b",
          segment: "ep-d#0",
          startSec: 0,
          endSec: 100,
        },
        candidates: [{ item: "x" }, { item: "ep-d", via: "dense" }],
      },
      {
        key: "0.0.1",
        tape: {
          item: "ep-d",
          via: "dense",
          show: "show-b",
          segment: "ep-d#0",
          startSec: 0,
          endSec: 160,
          merged: true,
        },
      },
      {
        key: "0.0.2",
        seeded: true,
        tape: {
          item: "ep-s",
          via: "dense",
          seedWon: true,
          segment: "ep-s#0",
          startSec: 0,
          endSec: 40,
        },
      },
      {
        key: "0.0.3",
        tier2Gate: "window-overlap",
        furthestVia: "dense",
        candidates: [{ item: "y", via: "dense" }],
      },
      {
        key: "0.0.4",
        tier2Gate: "window-overlap",
        furthestVia: "bm25",
        candidates: [{ item: "z", via: "both" }],
      },
    ]).summary;
    expect(s.denseOnlyCandidates).toBe(2);
    expect(s.denseOnlyWins).toBe(2);
    expect(s.denseOnlyWindowOverlapRefusals).toBe(1);
    expect(s.showVariety).toMatchObject({
      distinctShows: 2,
      distinctEpisodes: 2,
      tapeSecByShow: { "show-b": 160, "show-a": 40 },
    });
  });
});

describe("replayCompare: the verdict", () => {
  it("pass: a candidate arm that keeps every tape beat and rescues one unseeded beat passes both gates", () => {
    /* MUTATION THAT KILLS THIS: compare yields with <= instead of < (an equal
       yield then fails). Ran it: red on the identical-replay default pass. */
    const cand = replay(
      BASE.map((b) =>
        b.key === "0.0.4" ? { ...b, tape: { item: "ep-9" } } : b,
      ),
    );
    const c = compareReplays(replay(BASE), cand, { gate: "hybrid" });
    expect(c.verdict).toBe("pass");
    expect(c.reasons).toEqual([]);
    expect(c.gainedTape).toEqual(["0.0.4"]);
    expect(c.lostTape).toEqual([]);
    expect(c.unseededYield).toEqual({ base: 0.5, cand: 0.75 });
    expect(c.unseededTapeBeats).toEqual({ base: 2, cand: 3, delta: 1 });
    expect(c.beats.find((d) => d.key === "0.0.4")!.change).toBe("gained-tape");
    expect(c.beats.find((d) => d.key === "0.0.0")!.change).toBe("same");
    expect(compareReplays(replay(BASE), replay(BASE)).verdict).toBe("pass");
  });

  it("fail-lost-tape: a beat that found tape in base and none in the candidate fails, even when another beat is rescued", () => {
    /* MUTATION THAT KILLS THIS: drop the lost-tape reason (the yield is flat:
       one seeded beat lost, one unseeded rescued). Ran it: red. */
    const cand = replay(
      BASE.map((b) =>
        b.key === "0.0.0"
          ? { key: b.key, seeded: true }
          : b.key === "0.0.4"
            ? { ...b, tape: { item: "ep-9" } }
            : b,
      ),
    );
    const c = compareReplays(replay(BASE), cand, { gate: "hybrid" });
    expect(c.verdict).toBe("fail");
    expect(c.lostTape).toEqual(["0.0.0"]);
    expect(c.reasons).toEqual([
      "lost tape: 1 beat(s) that found tape in base found none (0.0.0)",
    ]);
    /* An unseeded loss also drops the yield, and says so. */
    const dropped = compareReplays(
      replay(BASE),
      replay(BASE.map((b) => (b.key === "0.0.3" ? { key: b.key } : b))),
    );
    expect(dropped.verdict).toBe("fail");
    expect(dropped.reasons).toEqual([
      "lost tape: 1 beat(s) that found tape in base found none (0.0.3)",
      "unseededYield dropped: 0.500 -> 0.250",
    ]);
  });

  it("fail-no-gain: the hybrid gate fails a candidate with no new unseeded tape and no dense-only win; a dense-only win alone passes", () => {
    /* MUTATION THAT KILLS THIS: drop the hybrid gain clause, or make it
       `delta >= 1 && denseOnlyWins > 0`. Ran both: red. */
    const same = compareReplays(replay(BASE), replay(BASE), { gate: "hybrid" });
    expect(same.verdict).toBe("fail");
    expect(same.reasons).toEqual([
      "no gain: unseeded tape beats 2 -> 2 and no dense-only win",
    ]);
    /* The same tape count, but one beat's winner is now a dense-only find. */
    const swapped = replay(
      BASE.map((b) =>
        b.key === "0.0.3" ? { ...b, tape: { item: "ep-7", via: "dense" } } : b,
      ),
    );
    const c = compareReplays(replay(BASE), swapped, { gate: "hybrid" });
    expect(c.verdict).toBe("pass");
    expect(c.denseOnlyWins).toEqual({ base: 0, cand: 1 });
    expect(c.beats.find((d) => d.key === "0.0.3")!.change).toBe("changed-tape");
  });

  it("replays of different beats are incomparable and fail; the summary is recomputed, never trusted", () => {
    /* MUTATION THAT KILLS THIS: read base.summary / cand.summary instead of
       recomputing (the forged summary then passes). Ran it: red. */
    const other = replay(BASE);
    other.beats[2] = {
      ...other.beats[2]!,
      claimHash: claimHash("a different claim"),
    };
    const c = compareReplays(replay(BASE), other);
    expect(c.verdict).toBe("fail");
    expect(c.reasons[0]).toMatch(/^incomparable/);
    expect(c.beats).toEqual([]);
    const forged = replay(BASE);
    forged.summary = {
      ...forged.summary,
      unseededTapeBeats: 9,
      denseOnlyWins: 3,
    };
    expect(
      compareReplays(replay(BASE), forged, { gate: "hybrid" }).verdict,
    ).toBe("fail");
  });
});

describe("replayCompare: the gold labels", () => {
  const hash = claimHash("synthetic claim 0.0.2");
  const row = {
    claim_hash: hash,
    show_id: "show-b",
    guid: "ep-2-guid",
    startSec: 10,
    endSec: 70,
    label: "on",
  };

  it("the schema rejects any string over 64 characters and any field it does not name, so no claim or transcript text fits", () => {
    /* MUTATION THAT KILLS THIS: drop the .max(GOLD_MAX_STRING) on the gold
       string fields, or .strict() on the row. Ran both: red. */
    expect(hash).toHaveLength(GOLD_MAX_STRING);
    expect(parseGold([row])).toEqual([row]);
    const long = "x".repeat(GOLD_MAX_STRING + 1);
    for (const field of ["claim_hash", "show_id", "guid"] as const) {
      expect(
        () =>
          parseGold([
            { ...row, [field]: field === "claim_hash" ? "a".repeat(65) : long },
          ]),
        field,
      ).toThrow(/gold file: 0\./);
    }
    expect(() => parseGold([{ ...row, claim: "the claim itself" }])).toThrow(
      /gold file/,
    );
    expect(() => parseGold([{ ...row, transcript: "a line" }])).toThrow(
      /gold file/,
    );
    expect(() => parseGold([{ ...row, label: "maybe" }])).toThrow(/label/);
    expect(() => parseGold([{ ...row, endSec: 5 }])).toThrow(/endSec/);
    expect(() => parseGold({ rows: [row] })).toThrow(/gold file/);
  });

  it("recall@8 counts a labelled episode found in its beat's top 8 candidates, per side, and the comparison reports it", () => {
    /* MUTATION THAT KILLS THIS: slice the candidates to 9, or count 'off'
       rows as relevant. Ran the first: red (the rank-8 find counts). */
    const nine = Array.from({ length: 9 }, (_, i) => ({ item: `c${i}` }));
    const base = replay([
      { key: "0.0.2", candidates: nine },
      { key: "0.0.3", candidates: [{ item: "ep-3" }] },
    ]);
    const cand = replay([
      { key: "0.0.2", candidates: [{ item: "c8" }, ...nine.slice(0, 8)] },
      { key: "0.0.3", candidates: [{ item: "ep-3" }] },
    ]);
    const gold = parseGold([
      {
        claim_hash: hash,
        show_id: "show-a",
        guid: "c8-guid",
        startSec: 0,
        endSec: 60,
        label: "on",
      },
      {
        claim_hash: hash,
        show_id: "show-a",
        guid: "c8-guid",
        startSec: 60,
        endSec: 90,
        label: "on",
      },
      {
        claim_hash: claimHash("synthetic claim 0.0.3"),
        show_id: "show-a",
        guid: "ep-3-guid",
        startSec: 0,
        endSec: 60,
        label: "adjacent",
      },
      {
        claim_hash: claimHash("synthetic claim 0.0.3"),
        show_id: "show-a",
        guid: "nope-guid",
        startSec: 0,
        endSec: 60,
        label: "off",
      },
      {
        claim_hash: "ab".repeat(32),
        show_id: "show-a",
        guid: "c1-guid",
        startSec: 0,
        endSec: 60,
        label: "on",
      },
    ]);
    expect(recallAt8(base, gold)).toEqual({ relevant: 1, found: 0, recall: 0 });
    expect(recallAt8(cand, gold)).toEqual({ relevant: 1, found: 1, recall: 1 });
    const c = compareReplays(base, cand, { gold });
    expect(c.recallAt8!.on).toEqual({
      base: { relevant: 1, found: 0, recall: 0 },
      cand: { relevant: 1, found: 1, recall: 1 },
    });
    expect(c.recallAt8!.onOrAdjacent.cand).toEqual({
      relevant: 2,
      found: 2,
      recall: 1,
    });
    expect(compareReplays(base, cand).recallAt8).toBeUndefined();
  });
});
