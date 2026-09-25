import { describe, expect, it } from "vitest";
import { deriveItemId, recordMintedSource, sourceBeats } from "../src/generation/sourceBeats";
import { disambiguateItemIds, legacyItemId, loadTranscriptArchive } from "../src/generation/transcriptArchiveLookup";
import { FileTranscriptTextIndex } from "../src/generation/transcriptTextIndex";
import type { TranscriptBodySource } from "../src/generation/transcriptTextIndex";
import type { TranscriptCue, TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";
import type { MintedSegmentSource } from "../src/generation/audioSourceLookup";
import type { DeepenedAct } from "../src/types/spine";

/**
 * Round-3 audit gen-6: a tier-2 item id is `<show_id>--<slug(title) cut to
 * 60>`, which is not unique per episode. Recurring round-ups share their first
 * 60 slug characters, so two episodes derived one id and the second mint's
 * audio row replaced the first's: a segment cut from episode A then played
 * episode B's enclosure.
 */
const TOPIC = "engineering/ai-robotics";
const ROUNDUP = "Scott Becker: 6 healthcare news stories we are following today, with a twist";

const a: TranscriptDigestEntry = {
  show_id: "practical-ai",
  show_title: "Practical AI",
  guid: "bk-1",
  title: `${ROUNDUP} (Monday)`,
  cues: 5,
  feed_duration_sec: 3600,
  enclosure_url: "https://cdn.example/bk-1.mp3"
};
const b: TranscriptDigestEntry = { ...a, guid: "bk-2", title: `${ROUNDUP} (Tuesday)`, enclosure_url: "https://cdn.example/bk-2.mp3" };
const unrelated: TranscriptDigestEntry = { ...a, guid: "bk-3", title: "A short title", enclosure_url: "https://cdn.example/bk-3.mp3" };

describe("gen-6: item ids are unique per episode", () => {
  it("the legacy ids of two round-ups collide (the bug), and disambiguateItemIds gives each its own", () => {
    expect(legacyItemId(a)).toBe(legacyItemId(b));
    const entries = disambiguateItemIds([{ ...a }, { ...b }, { ...unrelated }]);
    const ids = entries.map(deriveItemId);
    expect(new Set(ids).size).toBe(3);
    expect(ids[0]!.startsWith(legacyItemId(a))).toBe(true);
    expect(ids[0]).not.toBe(legacyItemId(a));
    /* An entry that collides with nothing keeps the id committed rows use. */
    expect(ids[2]).toBe(legacyItemId(unrelated));
  });

  it("is stable: the suffix is a hash of the guid, not of load order", () => {
    const one = disambiguateItemIds([{ ...a }, { ...b }]).map(deriveItemId);
    const two = disambiguateItemIds([{ ...b }, { ...a }]).map(deriveItemId);
    expect(new Set(one)).toEqual(new Set(two));
  });

  it("the loaded archive never gives two guids one item id", () => {
    /* MUTATION THAT KILLS THIS: drop the disambiguateItemIds call from
       loadTranscriptArchive (only bites when the digests on this machine hold
       a colliding pair, which the committed round-up rows do). */
    const byId = new Map<string, string>();
    const clashes: string[] = [];
    for (const entry of loadTranscriptArchive()) {
      const id = deriveItemId(entry);
      const guid = `${entry.show_id}/${entry.guid}`;
      const held = byId.get(id);
      if (held && held !== guid) clashes.push(id);
      byId.set(id, guid);
    }
    expect(clashes).toEqual([]);
  });

  describe("the mint guard: one item id never re-points at another episode", () => {
    const cuesA: TranscriptCue[] = [
      { text: "welcome back to the show today we are talking about hospital mergers", start_sec: 70, end_sec: 100 },
      { text: "the merger wave in rural hospitals closed more maternity wards than anyone admitted", start_sec: 100, end_sec: 108 },
      { text: "an audit found dozens of rural maternity wards closed across the whole region", start_sec: 108, end_sec: 120 },
      { text: "and those closures put a ceiling on the care anyone could get nearby", start_sec: 120, end_sec: 132 },
      { text: "we will come back to that after the break", start_sec: 132, end_sec: 150 }
    ];
    /* Episode B clip is 70 s: two short clips in a row would be refused by D2
       before the second mint is reached. */
    const cuesB: TranscriptCue[] = [
      { text: "welcome back to the show today we are talking about hospital mergers", start_sec: 470, end_sec: 500 },
      { text: "the merger wave in rural hospitals closed more maternity wards than anyone admitted", start_sec: 500, end_sec: 508 },
      { text: "an audit found dozens of rural maternity wards closed across the whole region", start_sec: 508, end_sec: 520 },
      { text: "and those closures put a ceiling on the care anyone could get nearby", start_sec: 520, end_sec: 532 },
      { text: "the audit of those rural maternity wards found closures across the whole region", start_sec: 532, end_sec: 550 },
      { text: "closures put a ceiling on the care anyone nearby could get across the region", start_sec: 550, end_sec: 570 },
      { text: "we will come back to that after the break", start_sec: 570, end_sec: 590 }
    ];
    const claim =
      "An audit found dozens of rural maternity wards closed across the whole region, and those closures put a ceiling on the care anyone could get nearby.";
    const act = (title: string, guid: string, start: number, len = 32): DeepenedAct => ({
      title,
      thesis: `${title} establishes closures.`,
      startState: "The listener does not know about closures.",
      endState: "The listener now understands closures.",
      slots: [{ title: `Closures ${title}`, beats: [{ claim, exploration: false, kind: "account", seed: { episodeId: guid, startSec: start, endSec: start + len } }] }],
      introduction: "Intro",
      exit: "Exit"
    });
    const audioSourceFor = (entry: TranscriptDigestEntry, itemId: string): MintedSegmentSource =>
      ({
        id: itemId,
        show: entry.show_title,
        title: entry.title,
        feed_url: null,
        episode_guid: String(entry.guid),
        audio_url: entry.enclosure_url!,
        audio_type: "audio/mpeg",
        duration_sec: 3600
      }) as MintedSegmentSource;
    const runWith = (archive: TranscriptDigestEntry[]) => {
      const cuesByGuid: Record<string, TranscriptCue[]> = { "bk-1": cuesA, "bk-2": cuesB };
      const bodies: TranscriptBodySource = {
        getCues: (entry) => cuesByGuid[entry.guid] ?? null,
        bodyStat: (entry) => (cuesByGuid[entry.guid] ? { mtimeMs: 1, size: 1 } : null)
      };
      return sourceBeats([act("Act A", "bk-1", 100), act("Act B", "bk-2", 500, 70)], {
        segmentPool: [],
        transcriptArchive: archive,
        cueProvider: bodies,
        textIndex: new FileTranscriptTextIndex({ archive, bodies, cache: false }),
        topic: TOPIC,
        audioSourceFor
      });
    };

    it("recordMintedSource refuses to re-point an item id at another episode, and accepts the same episode again", () => {
      /* MUTATION THAT KILLS THIS: drop the episode_guid check — the second
         episode's row silently replaces the first's. */
      const sources = new Map<string, MintedSegmentSource>();
      recordMintedSource(sources, "x", audioSourceFor(a, "x"));
      expect(() => recordMintedSource(sources, "x", audioSourceFor(a, "x"))).not.toThrow();
      expect(() => recordMintedSource(sources, "x", audioSourceFor(b, "x"))).toThrow(/gen-6/);
      expect(sources.get("x")!.episode_guid).toBe("bk-1");
    });

    it("undisambiguated, the two episodes were one to the ledger: the second was refused as the first's share (m4-share)", () => {
      const result = runWith([{ ...a }, { ...b }]);
      expect(result.newSegmentSources).toHaveLength(1);
      expect(result.sourcingTrace.map((t) => t.tier2?.gate)).toContain("m4-share");
    });

    it("with disambiguated ids each episode mints its own audio row", () => {
      const result = runWith(disambiguateItemIds([{ ...a }, { ...b }]));
      const guids = Object.fromEntries(result.newSegmentSources.map((s) => [s.id, s.episode_guid]));
      expect(Object.keys(guids)).toHaveLength(2);
      expect(new Set(Object.values(guids))).toEqual(new Set(["bk-1", "bk-2"]));
    });
  });
});
