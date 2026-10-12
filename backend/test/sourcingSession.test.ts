import { describe, it, expect, beforeAll, afterAll } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { createHash } from "crypto";
import {
  sourceBeats,
  SourcingSession,
  SOURCING_SNAPSHOT_VERSION,
  type SourceBeatsOptions,
  type SourcingSnapshot
} from "../src/generation/sourceBeats";
import { capArgumentBeats } from "../src/generation/deepenActs";
import { mintSegmentSource } from "../src/generation/audioSourceLookup";
import { FileTranscriptCueProvider, type TranscriptCue, type TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import { FileTranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import type { SegmentRecord } from "../src/generation/segmentPoolLookup";
import type { SourceBeatsResult } from "../src/types/tapeSourcing";
import type { DeepenedAct } from "../src/types/spine";

/**
 * GV-18 (docs/roadmap/generation-v2.md; R1-04): `SourcingSession` is
 * `sourceBeats` cut at the act boundary — act 0 can be sourced and frozen
 * before acts 1+ exist, and the ledgers it carries forward can be banked and
 * resumed. Pinned here: the extraction changed nothing (equivalence, and the
 * pre-extraction output's digest), an earlier act never moves once a later one
 * is sourced (deep-frozen), a snapshot survives a JSON round trip, and acts
 * cannot arrive out of order.
 *
 * THE CORPUS. Run 2's deepen output (`fixtures/run2-deepen-2026-09-09.json`)
 * with the argument cap applied, so 23 beats search, against nine SYNTHETIC
 * episodes on disk in a tmpdir: each searching beat's own words, spoken over
 * four 20 s cues and dealt round-robin onto the episodes between off-topic
 * filler — so episodes recur across acts and the Foray-wide ledgers (M3 order,
 * M4's placed-count cap, used ids) decide act 1+ from what act 0 placed. The
 * first searching beat of act 1 is GLUED onto the last of act 0 in the same
 * episode, which is a merge `Tier2Walk` refuses only because the clip belongs
 * to another act: the freeze below is a real constraint, not a vacuous one.
 * One act-0 beat is spoken nowhere (`UNSPOKEN`), so tier 3 logs it too.
 * Read through the REAL `FileTranscriptCueProvider` and `FileTranscriptTextIndex`
 * (its cache in the same tmpdir), with no topic (the lineage gate is inert) and
 * a pure audio resolver. Even without a topic, every placement's
 * `taxonomyNodeIds` / `families` are read off the catalogue, so `root` points
 * at a repo stand-in in the tmpdir whose `data/catalog.json` lists no shows:
 * the output, and the digest below, never depend on the committed catalogue.
 * (`taxonomyFamily.ts` caches those reads per module instance, not keyed
 * on `root`, so every call in this file must pass the same `root` — it does.)
 */

const RUN2: DeepenedAct[] = (
  JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "run2-deepen-2026-09-09.json"), "utf8")) as { acts: DeepenedAct[] }
).acts.map((a) => capArgumentBeats(a));

const SHOW = "practical-ai";
const EPISODES = 9;
/** One searching beat of act 0 that no episode speaks, so it reaches tier 3
 * and leaves a transcription-queue row in the ledgers act 1 inherits. */
const UNSPOKEN = "0.0.3";
const FILLER = [
  "anyway let us take a short break for a word from the people who pay for this show",
  "and we are back so thanks again to everybody who wrote in last week with questions",
  "my cousin keeps bees on a rooftop in the city which is a whole other conversation",
  "the weather here has been strange all month with rain every single afternoon"
];

/**
 * SHA-256 OF `JSON.stringify(sourceBeats(RUN2, options()))`, recorded from the
 * pre-extraction `sourceBeats` (origin/main 8606b2d0) over this exact corpus and
 * these exact options, `root` included.
 * It pins today's default sourcing output byte for byte: a later card that
 * changes it without a flag fails here. A deliberate default flip re-records
 * it, and says so in its PR.
 */
const PRE_EXTRACTION_DIGEST = "e82d02ed3ab7d8c7f82ce96c5cfdf8595991d35c641b028ac1e3cb74ad3baa95";

/** A claim's own words, spoken over four 20 s cues from `startSec`. */
function claimCues(claim: string, startSec: number): TranscriptCue[] {
  const words = claim
    .replace(/[^A-Za-z0-9' ]+/g, " ")
    .split(/\s+/)
    .filter(Boolean);
  const per = Math.ceil(words.length / 4);
  const cues: TranscriptCue[] = [];
  for (let i = 0; i < 4; i++) {
    const text = words
      .slice(i * per, (i + 1) * per)
      .join(" ")
      .toLowerCase();
    cues.push({ text: text || "right", start_sec: startSec + i * 20, end_sec: startSec + (i + 1) * 20 });
  }
  return cues;
}

function buildCorpus(acts: DeepenedAct[]): { archive: TranscriptDigestEntry[]; cuesByGuid: Record<string, TranscriptCue[]> } {
  const dealt: Array<{ claim: string; episode: number; glued: boolean }> = [];
  acts.forEach((act, actIndex) => {
    let firstOfAct = true;
    act.slots.forEach((slot, slotIndex) => {
      slot.beats.forEach((beat, beatIndex) => {
        if (beat.kind === "argument" || `${actIndex}.${slotIndex}.${beatIndex}` === UNSPOKEN) return;
        const glued = actIndex === 1 && firstOfAct && dealt.length > 0;
        const episode = glued ? dealt[dealt.length - 1]!.episode : dealt.length % EPISODES;
        dealt.push({ claim: beat.claim, episode, glued });
        firstOfAct = false;
      });
    });
  });
  const cuesByGuid: Record<string, TranscriptCue[]> = {};
  const archive: TranscriptDigestEntry[] = [];
  for (let e = 0; e < EPISODES; e++) {
    const guid = `synthetic-ep-${e}`;
    const cues: TranscriptCue[] = [];
    let t = 0;
    const filler = (n: number) => {
      for (let k = 0; k < n; k++) {
        cues.push({ text: FILLER[(t / 20) % FILLER.length]!, start_sec: t, end_sec: t + 20 });
        t += 20;
      }
    };
    filler(3);
    const mine = dealt.filter((d) => d.episode === e);
    mine.forEach((d, i) => {
      for (const c of claimCues(d.claim, t)) cues.push(c);
      t += 80;
      if (!mine[i + 1]?.glued) filler(8);
    });
    cuesByGuid[guid] = cues;
    archive.push({
      show_id: SHOW,
      show_title: "Practical AI",
      guid,
      title: `Episode ${900 + e}`,
      cues: cues.length,
      feed_duration_sec: Math.max(3600, t + 60),
      enclosure_url: `https://cdn.example/${guid}.mp3`
    });
  }
  return { archive, cuesByGuid };
}

/** One committed pool row whose why-line echoes an act-2 claim, so tier 1
 * places a pool segment mid-Foray too. Its episode has no body here, so tier 1
 * scores the metadata. */
const POOL: SegmentRecord[] = [
  {
    id: "synthetic-pool-ep#300",
    item_id: "synthetic-pool-ep",
    topic: "engineering/ai-robotics",
    start_sec: 300,
    end_sec: 420,
    reference_duration_sec: 3600,
    start_anchor: "so in the spring of twenty twenty",
    end_anchor: "and every forecast broke at once",
    why: "Spring 2020 broke every production demand-forecasting model at once: the recent past stopped predicting the near future",
    confidence: "high",
    transcript_source: "publisher",
    dai_suspected: false,
    source: "agent-v1",
    batch_id: "seg-test",
    needs_review: false
  }
];

const SHOW_META = new Map([[SHOW, { dai: false, feedUrl: "https://feeds.example/practical-ai.xml", appleCollectionId: null }]]);

let root = "";
let options: () => SourceBeatsOptions;

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "foray-sourcing-session-"));
  const corpus = buildCorpus(RUN2);
  const showDir = path.join(root, "normalized", SHOW);
  fs.mkdirSync(showDir, { recursive: true });
  for (const entry of corpus.archive) {
    fs.writeFileSync(path.join(showDir, `${entry.guid}.json`), JSON.stringify({ show_id: SHOW, guid: entry.guid, cues: corpus.cuesByGuid[entry.guid] }));
  }
  /* The catalogue the taxonomy joins read: empty, so no committed data leaks in. */
  const repoRoot = path.join(root, "repo");
  fs.mkdirSync(path.join(repoRoot, "data"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "data", "catalog.json"), JSON.stringify({ shows: [] }));
  /* A fresh provider and index per session, as two processes would have; the
     index's disk cache is shared, as it is on a machine. */
  options = () => {
    const cueProvider = new FileTranscriptCueProvider(path.join(root, "normalized"));
    return {
      segmentPool: POOL,
      transcriptArchive: corpus.archive,
      cueProvider,
      textIndex: new FileTranscriptTextIndex({ archive: corpus.archive, bodies: cueProvider, indexRoot: path.join(root, "index") }),
      topic: null,
      root: repoRoot,
      audioSourceFor: (entry, itemId) => mintSegmentSource(entry, itemId, SHOW_META)
    };
  };
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

function digest(result: SourceBeatsResult): string {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

function tapeCount(result: SourceBeatsResult, actIndex: number): number {
  return result.acts[actIndex]!.slots.flatMap((s) => s.beats).filter((b) => b.sourcing === "tape").length;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}

describe("SourcingSession — the extraction changed nothing", () => {
  it("the corpus is not vacuous: every act places tape, tier 1 and tier 2 both place, episodes recur across acts", () => {
    const result = sourceBeats(RUN2, options());
    for (let a = 0; a < RUN2.length; a++) expect(tapeCount(result, a)).toBeGreaterThan(0);
    expect(result.tapeRelevance.some((r) => r.tier === 1)).toBe(true);
    expect(result.tapeRelevance.some((r) => r.tier === 2)).toBe(true);
    expect(result.newSegmentSources.length).toBeGreaterThan(0);
    expect(result.sourcingTrace.length).toBeGreaterThan(0);
    expect(result.transcriptionQueueCandidates.length).toBeGreaterThan(0);
    const actsByItem = new Map<string, Set<number>>();
    for (const r of result.tapeRelevance) actsByItem.set(r.itemId, (actsByItem.get(r.itemId) ?? new Set()).add(r.actIndex));
    expect([...actsByItem.values()].some((acts) => acts.size >= 3)).toBe(true);
  });

  it("sourceBeats over the corpus is byte-identical to the pre-extraction sourceBeats", () => {
    expect(digest(sourceBeats(RUN2, options()))).toBe(PRE_EXTRACTION_DIGEST);
  });

  it("act by act, with result() read between acts, deep-equals sourceBeats over all acts", () => {
    const whole = sourceBeats(RUN2, options());
    const session = new SourcingSession(options());
    RUN2.forEach((act, i) => {
      const sourced = session.sourceAct(act, i);
      expect(session.sourcedActCount).toBe(i + 1);
      const sofar = session.result(RUN2);
      expect(sofar.acts).toHaveLength(i + 1);
      expect(sofar.acts[i]).toBe(sourced);
    });
    const byAct = session.result(RUN2);
    expect(byAct).toStrictEqual(whole);
    expect(digest(byAct)).toBe(PRE_EXTRACTION_DIGEST);
  });
});

describe("SourcingSession — an act is frozen once the next one starts", () => {
  it("sourcing acts 1+ never changes act 0's SourcedAct, newSegments rows or tapeRelevance rows", () => {
    const session = new SourcingSession(options());
    const act0 = session.sourceAct(RUN2[0]!, 0);
    const after0 = session.result(RUN2);
    const segments0 = after0.newSegments;
    const relevance0 = after0.tapeRelevance.filter((r) => r.actIndex === 0);
    expect(segments0.length).toBeGreaterThan(0);
    expect(relevance0.length).toBeGreaterThan(0);
    const before = structuredClone({ act0, segments0, relevance0 });

    /* Frozen in place: any write the later acts made to these objects would
       throw (module code is strict), not just show up in the comparison. */
    deepFreeze(act0);
    for (const s of segments0) deepFreeze(s);
    for (const r of relevance0) deepFreeze(r);

    for (let i = 1; i < RUN2.length; i++) session.sourceAct(RUN2[i]!, i);
    const final = session.result(RUN2);

    expect(final.acts[0]).toBe(act0);
    expect({ act0, segments0, relevance0 }).toStrictEqual(before);
    expect(final.newSegments.slice(0, segments0.length)).toStrictEqual(before.segments0);
    expect(final.tapeRelevance.filter((r) => r.actIndex === 0)).toStrictEqual(before.relevance0);
    /* And the glued beat really was a candidate: act 1's first tape is the
       same episode as act 0's last, minted as its own clip. */
    const lastOf0 = relevance0[relevance0.length - 1]!;
    const firstOf1 = final.tapeRelevance.find((r) => r.actIndex === 1)!;
    expect(firstOf1.itemId).toBe(lastOf0.itemId);
    expect(firstOf1.segmentId).not.toBe(lastOf0.segmentId);
    expect(firstOf1.mergedInto).toBeUndefined();
  });
});

describe("SourcingSession — exportState / resume", () => {
  const uninterrupted = () => sourceBeats(RUN2, options());

  for (let boundary = 1; boundary < 4; boundary++) {
    it(`banking after act ${boundary - 1}, a JSON round trip and a resume source the rest exactly as an uninterrupted session`, () => {
      const first = new SourcingSession(options());
      for (let i = 0; i < boundary; i++) first.sourceAct(RUN2[i]!, i);
      const banked = JSON.parse(JSON.stringify(first.exportState())) as SourcingSnapshot;

      const resumed = SourcingSession.resume(options(), banked);
      expect(resumed.sourcedActCount).toBe(boundary);
      for (let i = boundary; i < RUN2.length; i++) resumed.sourceAct(RUN2[i]!, i);
      const result = resumed.result(RUN2);

      expect(result).toEqual(uninterrupted());
      expect(digest(result)).toBe(PRE_EXTRACTION_DIGEST);
    });
  }

  it("is JSON-safe, carries every ledger, and resume().exportState() gives the same snapshot back", () => {
    const session = new SourcingSession(options());
    session.sourceAct(RUN2[0]!, 0);
    session.sourceAct(RUN2[1]!, 1);
    const snapshot = session.exportState();
    expect(JSON.parse(JSON.stringify(snapshot))).toStrictEqual(snapshot);
    expect(Object.keys(snapshot).sort()).toEqual(
      [
        "version",
        "usedSegmentIds",
        "lastStartByItem",
        "lastEndByItem",
        "usedCountByItem",
        "placedTapeCount",
        "placedDurations",
        "placedSecByItem",
        "longestSecByItem",
        "placed",
        "mintedIds",
        "newSegments",
        "newSegmentSources",
        "transcriptionQueueCandidates",
        "tapeRelevance",
        "sourcingTrace",
        "lastMintedClip",
        "acts"
      ].sort()
    );
    expect(snapshot.version).toBe(SOURCING_SNAPSHOT_VERSION);
    expect(snapshot.lastMintedClip).toBeNull();
    expect(snapshot.acts).toHaveLength(2);
    expect(snapshot.transcriptionQueueCandidates.length).toBeGreaterThan(0);
    expect(snapshot.placedTapeCount).toBe(snapshot.placedDurations.length);
    /* The per-episode ledgers, recomputed independently from the placement log
       (`placed`, positionally parallel to `placedDurations`) — an export that
       emptied or garbled any one of them would otherwise round-trip cleanly. */
    expect(snapshot.placed).toHaveLength(snapshot.placedTapeCount);
    expect(snapshot.placedTapeCount).toBeGreaterThan(0);
    const countByItem = new Map<string, number>();
    const secByItem = new Map<string, number>();
    const longestByItem = new Map<string, number>();
    snapshot.placed.forEach(({ itemId }, i) => {
      const sec = snapshot.placedDurations[i]!;
      countByItem.set(itemId, (countByItem.get(itemId) ?? 0) + 1);
      secByItem.set(itemId, (secByItem.get(itemId) ?? 0) + sec);
      longestByItem.set(itemId, Math.max(longestByItem.get(itemId) ?? 0, sec));
    });
    expect(new Map(snapshot.usedCountByItem)).toStrictEqual(countByItem);
    expect(new Map(snapshot.placedSecByItem)).toStrictEqual(secByItem);
    expect(new Map(snapshot.longestSecByItem)).toStrictEqual(longestByItem);
    /* Every clip placed, by id: the tape rows that opened a clip (a merged
       beat rides in an earlier clip and adds no id). */
    const placedIds = snapshot.tapeRelevance.filter((r) => r.mergedInto === undefined).map((r) => r.segmentId);
    expect(placedIds).toHaveLength(snapshot.placedTapeCount);
    expect(new Set(snapshot.usedSegmentIds)).toStrictEqual(new Set(placedIds));
    expect(snapshot.usedSegmentIds).toHaveLength(placedIds.length);
    expect(snapshot.mintedIds).toEqual(expect.arrayContaining([POOL[0]!.id, ...snapshot.newSegments.map((s) => s.id)]));
    expect(SourcingSession.resume(options(), snapshot).exportState()).toStrictEqual(snapshot);
  });

  it("shares no object with the live session: sourcing on does not change a snapshot already taken", () => {
    const session = new SourcingSession(options());
    session.sourceAct(RUN2[0]!, 0);
    const snapshot = session.exportState();
    const copy = structuredClone(snapshot);
    for (let i = 1; i < RUN2.length; i++) session.sourceAct(RUN2[i]!, i);
    expect(snapshot).toStrictEqual(copy);
  });

  it("refuses a snapshot of another version", () => {
    const snapshot = new SourcingSession(options()).exportState();
    expect(() => SourcingSession.resume(options(), { ...snapshot, version: 2 } as unknown as SourcingSnapshot)).toThrow(/version 2/);
  });
});

describe("SourcingSession — acts arrive in order", () => {
  it("throws for an act that is not the next one: skipped ahead, repeated, or behind a resume", () => {
    const fresh = new SourcingSession(options());
    expect(() => fresh.sourceAct(RUN2[1]!, 1)).toThrow(/out of order/);

    const session = new SourcingSession(options());
    session.sourceAct(RUN2[0]!, 0);
    expect(() => session.sourceAct(RUN2[0]!, 0)).toThrow(/out of order/);
    expect(() => session.sourceAct(RUN2[2]!, 2)).toThrow(/out of order/);

    const resumed = SourcingSession.resume(options(), session.exportState());
    expect(() => resumed.sourceAct(RUN2[0]!, 0)).toThrow(/out of order/);
    expect(() => resumed.sourceAct(RUN2[1]!, 1)).not.toThrow();
  });

  it("result() checks the acts sourced so far against the deepened acts they came from", () => {
    const session = new SourcingSession(options());
    session.sourceAct(RUN2[0]!, 0);
    expect(session.result(RUN2).acts).toHaveLength(1);
    expect(() => session.result(RUN2.slice(1))).toThrow(/beat-preservation guardrail/);
    expect(() => session.result([])).toThrow(/beat-preservation guardrail/);
  });
});
