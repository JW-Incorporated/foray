import { createHash } from "crypto";
import { z } from "zod";
import { computeShowVariety, type ShowVarietyResult } from "./veracityMetrics";

/**
 * THE RETRIEVAL REPLAY'S REPORT AND ITS GO/NO-GO COMPARISON (GV-88; roadmap
 * docs/roadmap/generation-v2.md, from W3-15; covers R2-04, QK-22, R1-09).
 *
 * `cli/replaySourcing.ts` runs §4.5 sourcing alone (no model) over a banked
 * deepen output and writes one `ReplayReport`: per beat, how it was sourced,
 * the gate that decided, whether it was seeded and whether the seed won, the
 * candidates the text index handed sourcing (each with its `via`), and the
 * winner. This module is the pure half: the summary numbers, the per-beat diff
 * between two replays, the verdict, and the gold-label schema. No file system,
 * no network, no clock.
 *
 * THE NUMBER THE GATE IS ARGUED ON is MQ-09's tape yield restricted to the
 * beats the spine did NOT seed (`unseededYield`): unseeded beats that found
 * tape over unseeded beats that searched. A seeded beat's tape is found by
 * opening the episode the spine read, whatever the retrieval arm, so it says
 * nothing about retrieval; the unseeded beats are the ones a better index can
 * rescue (tape-yield brief 2026-09-10 §4, cause 1: 14 of the 17 refused beats
 * were unseeded). The denominator is the same as `computeTapeYield`'s
 * (veracityMetrics.ts): a `skipped:argument` beat never searched and is not in
 * it.
 *
 * THE VERDICT ('pass' or 'fail'), `compareReplays(base, cand)`:
 *   - no beat that found tape in `base` loses it in `cand`;
 *   - `unseededYield` does not drop;
 *   - for the hybrid gate only, it RISES by at least one beat (one more
 *     unseeded beat found tape) or `cand` has at least one dense-only win.
 * Two replays of different beats (another fixture, an edited claim) are not
 * comparable and fail with that reason, never a silent diff.
 *
 * THE GOLD FILE (optional; tools/passage-index/eval/gold.json) holds ids and
 * seconds only: a claim HASH (`claimHash`, sha256 hex of the trimmed claim),
 * the episode (show_id, guid), the labelled window's seconds and a label
 * (on | adjacent | off, the tape-yield brief's verdicts). `parseGold` rejects
 * any string over 64 characters and any field it does not name, so neither a
 * claim nor a transcript line can be committed in it. With gold present the
 * comparison reports candidate recall@8 for both sides.
 */

export const REPLAY_FORMAT = "replay-sourcing/1";

/** The candidate depth recall is measured at: tier 2's text-index list
 * (`TRANSCRIPT_TEXT_CANDIDATES`). */
export const RECALL_AT = 8;

/** The longest string a gold row may hold. A sha256 hex is exactly 64. */
export const GOLD_MAX_STRING = 64;

export type ReplayGate = "default" | "hybrid";

/** One candidate the text index handed sourcing for a beat, in rank order. */
export interface ReplayCandidate {
  showId: string;
  guid: string;
  /** `deriveItemId` of the archive entry: what a minted segment would carry. */
  itemId: string;
  rank: number;
  /** How the retrieval arm found it: `bm25`, `dense` or `both` (GV-48). The
   * local File index is BM25 only, so its candidates say `bm25`. */
  via: string;
}

/** The tape a beat took. */
export interface ReplayWinner {
  segmentId: string;
  itemId: string;
  tier: 1 | 2;
  startSec: number;
  endSec: number;
  /** `showKeyForItem` (showIdentity.ts), for show variety. */
  showKey: string;
  /** How the winning episode reached sourcing: a candidate's own `via`
   * (bm25 / dense / both), `seed` (the seeded episode, not in the text
   * results), `pool` (a tier-1 pool row no candidate named) or `title` (tier
   * 2's title-metadata fallback). */
  via: string;
  /** F-96: rides in an earlier beat's clip. */
  merged: boolean;
}

export interface ReplayBeat {
  /** `<act>.<slot>.<beat>`. */
  key: string;
  actIndex: number;
  slotIndex: number;
  beatIndex: number;
  /** sha256 hex of the trimmed claim: what a gold row names. */
  claimHash: string;
  /** The claim itself, for the person reading a local replay. Never copied
   * into a gold row or a diff. */
  claim: string;
  kind: "account" | "argument";
  /** False only for a `skipped:argument` beat (no search ran). */
  searched: boolean;
  seeded: boolean;
  sourcing: "tape" | "narration";
  tier: 1 | 2 | null;
  /** The deciding gate: `placed` for a tape beat, `skipped:argument`, else the
   * trace's furthest tier-2 gate (tier 1's when tier 2 has no row). */
  gate: string;
  tier1Gate: string | null;
  tier2Gate: string | null;
  /** The gate that refused the seed window itself (G-24 R3), when one did. */
  seedGate: string | null;
  /** Whether the seed's window is the tape that won; null for an unseeded beat. */
  seedWindowWon: boolean | null;
  candidates: ReplayCandidate[];
  winner: ReplayWinner | null;
  /** For a narrated beat, the `via` of the candidate tier 2 got furthest with
   * (matched by show and episode title), when it was one of `candidates`. */
  furthestVia: string | null;
}

export interface ReplaySummary {
  beats: number;
  searchedBeats: number;
  tapeBeats: number;
  seededBeats: number;
  seedsWon: number;
  /** Unseeded beats that searched (the MQ-09 denominator, unseeded only). */
  unseededBeats: number;
  unseededTapeBeats: number;
  /** unseededTapeBeats / unseededBeats; null when no unseeded beat searched. */
  unseededYield: number | null;
  showVariety: ShowVarietyResult;
  /** Candidates (summed over beats) the dense arm alone found. */
  denseOnlyCandidates: number;
  /** Tape beats whose winner only the dense arm found (not the seed's own window). */
  denseOnlyWins: number;
  /** Narrated beats refused at `window-overlap` on a dense-only candidate:
   * retrieval found the episode and the window floor turned it down, which
   * says the judge rather than retrieval is the bottleneck. */
  denseOnlyWindowOverlapRefusals: number;
}

export interface ReplayReport {
  format: typeof REPLAY_FORMAT;
  /** The fixture's basename and the run's inputs, so a diff can say what it compared. */
  fixture: string;
  topic: string | null;
  retrieval: { source: "local" | "remote"; mode: "bm25" | "hybrid" };
  showShare: string;
  beats: ReplayBeat[];
  summary: ReplaySummary;
  /** Remote only: the client's counters (misses and hydrationMisses show drift)
   * and the dense-only candidates the server returned, including those the
   * candidate limit cut before sourcing saw them. */
  retrievalStats?: Record<string, unknown>;
}

/** sha256 hex of the trimmed claim. */
export function claimHash(claim: string): string {
  return createHash("sha256").update(claim.trim(), "utf8").digest("hex");
}

/** The summary numbers of a replay, from its beats alone. */
export function summarizeReplayBeats(
  beats: readonly ReplayBeat[],
): ReplaySummary {
  const searched = beats.filter((b) => b.searched);
  const unseeded = searched.filter((b) => !b.seeded);
  const unseededTapeBeats = unseeded.filter(
    (b) => b.sourcing === "tape",
  ).length;
  /* One clip per segment id: a merged beat rides in its carrier's clip, and
     the clip's seconds are its widest extent. */
  const clips = new Map<
    string,
    { showKey: string; itemId: string; startSec: number; endSec: number }
  >();
  for (const b of beats) {
    const w = b.winner;
    if (!w) continue;
    const held = clips.get(w.segmentId);
    if (!held)
      clips.set(w.segmentId, {
        showKey: w.showKey,
        itemId: w.itemId,
        startSec: w.startSec,
        endSec: w.endSec,
      });
    else
      clips.set(w.segmentId, {
        ...held,
        startSec: Math.min(held.startSec, w.startSec),
        endSec: Math.max(held.endSec, w.endSec),
      });
  }
  const showVariety = computeShowVariety(
    [...clips.values()].map((c) => ({
      showKey: c.showKey,
      itemId: c.itemId,
      durationSec: c.endSec - c.startSec,
    })),
  );
  return {
    beats: beats.length,
    searchedBeats: searched.length,
    tapeBeats: beats.filter((b) => b.sourcing === "tape").length,
    seededBeats: searched.filter((b) => b.seeded).length,
    seedsWon: beats.filter((b) => b.seedWindowWon === true).length,
    unseededBeats: unseeded.length,
    unseededTapeBeats,
    unseededYield:
      unseeded.length > 0 ? unseededTapeBeats / unseeded.length : null,
    showVariety,
    denseOnlyCandidates: beats.reduce(
      (n, b) => n + b.candidates.filter((c) => c.via === "dense").length,
      0,
    ),
    denseOnlyWins: beats.filter(
      (b) =>
        b.winner !== null &&
        b.winner.via === "dense" &&
        b.seedWindowWon !== true,
    ).length,
    denseOnlyWindowOverlapRefusals: beats.filter(
      (b) =>
        b.sourcing === "narration" &&
        b.tier2Gate === "window-overlap" &&
        b.furthestVia === "dense",
    ).length,
  };
}

/* ------------------------------------------------------------------ */
/* Gold labels                                                          */
/* ------------------------------------------------------------------ */

const goldString = z.string().min(1).max(GOLD_MAX_STRING);

export const GoldRowSchema = z
  .object({
    claim_hash: goldString.regex(/^[0-9a-f]+$/, "claim_hash is lower-case hex"),
    show_id: goldString,
    guid: goldString,
    startSec: z.number().finite().nonnegative(),
    endSec: z.number().finite().positive(),
    label: z.enum(["on", "adjacent", "off"]),
  })
  .strict()
  .refine((row) => row.endSec > row.startSec, {
    message: "endSec must be greater than startSec",
  });
export type GoldRow = z.infer<typeof GoldRowSchema>;

/** Parses a gold file's JSON; throws naming the first bad row. */
export function parseGold(raw: unknown): GoldRow[] {
  const parsed = z.array(GoldRowSchema).safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `gold file: ${issue ? `${issue.path.join(".") || "(root)"}: ${issue.message}` : "invalid"}`,
    );
  }
  return parsed.data;
}

export interface RecallAt {
  /** Gold rows (deduplicated by claim, show, episode) of the counted labels
   * whose claim is a beat of the replay. */
  relevant: number;
  /** Of those, the ones whose episode is in that beat's top RECALL_AT candidates. */
  found: number;
  recall: number | null;
}

/** Candidate recall@8 of one replay against gold rows of the given labels. */
export function recallAt8(
  replay: ReplayReport,
  gold: readonly GoldRow[],
  labels: ReadonlyArray<GoldRow["label"]> = ["on"],
): RecallAt {
  const byHash = new Map<string, ReplayBeat[]>();
  for (const b of replay.beats)
    byHash.set(b.claimHash, [...(byHash.get(b.claimHash) ?? []), b]);
  const seen = new Set<string>();
  let relevant = 0;
  let found = 0;
  for (const row of gold) {
    if (!labels.includes(row.label)) continue;
    const key = `${row.claim_hash}\u0000${row.show_id}\u0000${row.guid}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const beats = byHash.get(row.claim_hash);
    if (!beats) continue;
    relevant += 1;
    const hit = beats.some((b) =>
      b.candidates
        .slice(0, RECALL_AT)
        .some((c) => c.showId === row.show_id && c.guid === row.guid),
    );
    if (hit) found += 1;
  }
  return { relevant, found, recall: relevant > 0 ? found / relevant : null };
}

/* ------------------------------------------------------------------ */
/* Comparison                                                           */
/* ------------------------------------------------------------------ */

export type BeatChange =
  "same" | "gained-tape" | "lost-tape" | "changed-tape" | "narration";

export interface BeatSide {
  sourcing: "tape" | "narration";
  gate: string;
  itemId: string | null;
  via: string | null;
}

export interface BeatDiff {
  key: string;
  claimHash: string;
  seeded: boolean;
  change: BeatChange;
  base: BeatSide;
  cand: BeatSide;
}

export interface ReplayComparison {
  verdict: "pass" | "fail";
  gate: ReplayGate;
  /** Why it failed, one line each; empty on a pass. */
  reasons: string[];
  beats: BeatDiff[];
  lostTape: string[];
  gainedTape: string[];
  unseededYield: { base: number | null; cand: number | null };
  unseededTapeBeats: { base: number; cand: number; delta: number };
  denseOnlyWins: { base: number; cand: number };
  denseOnlyWindowOverlapRefusals: { base: number; cand: number };
  recallAt8?: {
    on: { base: RecallAt; cand: RecallAt };
    onOrAdjacent: { base: RecallAt; cand: RecallAt };
  };
}

export interface CompareOptions {
  gate?: ReplayGate;
  gold?: readonly GoldRow[];
}

function sideOf(b: ReplayBeat): BeatSide {
  return {
    sourcing: b.sourcing,
    gate: b.gate,
    itemId: b.winner?.itemId ?? null,
    via: b.winner?.via ?? null,
  };
}

function changeOf(base: ReplayBeat, cand: ReplayBeat): BeatChange {
  if (base.sourcing === "tape" && cand.sourcing !== "tape") return "lost-tape";
  if (base.sourcing !== "tape" && cand.sourcing === "tape")
    return "gained-tape";
  if (base.sourcing !== "tape") return "narration";
  const a = base.winner;
  const b = cand.winner;
  return a && b && a.segmentId === b.segmentId && a.itemId === b.itemId
    ? "same"
    : "changed-tape";
}

/**
 * The per-beat diff of two replays of the same beats and the go/no-go verdict
 * (see the module comment). `base` is today's arm (bm25), `cand` the arm under
 * test. The summary numbers are recomputed from the beats, so a hand-edited
 * summary cannot pass a replay its beats would fail.
 */
export function compareReplays(
  base: ReplayReport,
  cand: ReplayReport,
  options: CompareOptions = {},
): ReplayComparison {
  const gate: ReplayGate = options.gate ?? "default";
  const reasons: string[] = [];
  const baseSum = summarizeReplayBeats(base.beats);
  const candSum = summarizeReplayBeats(cand.beats);

  const candByKey = new Map(cand.beats.map((b) => [b.key, b]));
  const sameBeats =
    base.beats.length === cand.beats.length &&
    base.beats.every((b) => candByKey.get(b.key)?.claimHash === b.claimHash);
  if (!sameBeats)
    reasons.push(
      "incomparable: the two replays are not of the same beats (key or claim differs)",
    );

  const beats: BeatDiff[] = [];
  if (sameBeats) {
    for (const b of base.beats) {
      const c = candByKey.get(b.key)!;
      beats.push({
        key: b.key,
        claimHash: b.claimHash,
        seeded: b.seeded,
        change: changeOf(b, c),
        base: sideOf(b),
        cand: sideOf(c),
      });
    }
  }
  const lostTape = beats
    .filter((d) => d.change === "lost-tape")
    .map((d) => d.key);
  const gainedTape = beats
    .filter((d) => d.change === "gained-tape")
    .map((d) => d.key);
  if (lostTape.length > 0)
    reasons.push(
      `lost tape: ${lostTape.length} beat(s) that found tape in base found none (${lostTape.join(", ")})`,
    );

  const delta = candSum.unseededTapeBeats - baseSum.unseededTapeBeats;
  const yieldDropped =
    baseSum.unseededYield !== null &&
    (candSum.unseededYield === null ||
      candSum.unseededYield < baseSum.unseededYield);
  if (sameBeats && yieldDropped) {
    reasons.push(
      `unseededYield dropped: ${fmt(baseSum.unseededYield)} -> ${fmt(candSum.unseededYield)}`,
    );
  }
  if (gate === "hybrid" && !(delta >= 1 || candSum.denseOnlyWins > 0)) {
    reasons.push(
      `no gain: unseeded tape beats ${baseSum.unseededTapeBeats} -> ${candSum.unseededTapeBeats} and no dense-only win`,
    );
  }

  const comparison: ReplayComparison = {
    verdict: reasons.length === 0 ? "pass" : "fail",
    gate,
    reasons,
    beats,
    lostTape,
    gainedTape,
    unseededYield: { base: baseSum.unseededYield, cand: candSum.unseededYield },
    unseededTapeBeats: {
      base: baseSum.unseededTapeBeats,
      cand: candSum.unseededTapeBeats,
      delta,
    },
    denseOnlyWins: { base: baseSum.denseOnlyWins, cand: candSum.denseOnlyWins },
    denseOnlyWindowOverlapRefusals: {
      base: baseSum.denseOnlyWindowOverlapRefusals,
      cand: candSum.denseOnlyWindowOverlapRefusals,
    },
  };
  if (options.gold) {
    comparison.recallAt8 = {
      on: {
        base: recallAt8(base, options.gold, ["on"]),
        cand: recallAt8(cand, options.gold, ["on"]),
      },
      onOrAdjacent: {
        base: recallAt8(base, options.gold, ["on", "adjacent"]),
        cand: recallAt8(cand, options.gold, ["on", "adjacent"]),
      },
    };
  }
  return comparison;
}

function fmt(n: number | null): string {
  return n === null ? "n/a" : n.toFixed(3);
}
