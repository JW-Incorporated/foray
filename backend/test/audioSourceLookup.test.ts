import { describe, it, expect } from "vitest";
import { enclosureMime, loadShowAudioMeta, mintSegmentSource, type ShowAudioMeta } from "../src/generation/audioSourceLookup";
import type { TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";

/**
 * The `data/segment-sources.json` row a tier-2 minted segment needs, and the
 * five refusals that keep this pipeline from writing one it cannot vouch for
 * (finding F-49's plumbing half).
 *
 * Why every case here is a REFUSAL and only one is a success: the failure this
 * module exists to prevent is not "no row" — that just costs a beat its tape —
 * it is a row that LOOKS resolvable and is not, which reaches `data/`, ships to
 * a listener, and fails at playback where nothing is watching.
 */

const SHOW_META = new Map<string, ShowAudioMeta>([
  ["practical-ai", { dai: true, feedUrl: "https://changelog.com/practicalai/feed", appleCollectionId: 1406537385 }],
  ["no-verdict-show", { dai: null, feedUrl: "https://example.invalid/feed.xml", appleCollectionId: 1 }]
]);

function entry(overrides: Partial<TranscriptDigestEntry> = {}): TranscriptDigestEntry {
  return {
    show_id: "practical-ai",
    show_title: "Practical AI",
    guid: "0285ede8-e11a-414d-baa3-c667ce5c971b",
    title: "Chris on AI, autonomous swarming, home automation and Rust!",
    cues: 416,
    feed_duration_sec: 5829,
    enclosure_url: "https://media.transistor.fm/50ac2613/493156dd.mp3",
    ...overrides
  };
}

describe("audioSourceLookup — the row that makes minted tape playable", () => {
  it("builds the registry row from the digest's own enclosure, duration and show title", () => {
    const row = mintSegmentSource(entry(), "practical-ai--chris-on-ai", SHOW_META);
    expect(row).toEqual({
      id: "practical-ai--chris-on-ai",
      show: "Practical AI",
      title: "Chris on AI, autonomous swarming, home automation and Rust!",
      feed_url: "https://changelog.com/practicalai/feed",
      episode_guid: "0285ede8-e11a-414d-baa3-c667ce5c971b",
      audio_url: "https://media.transistor.fm/50ac2613/493156dd.mp3",
      audio_type: "audio/mpeg",
      duration_sec: 5829,
      dai_suspected: true,
      source: "generation-tier-2"
    });
  });

  it("takes the item id it is GIVEN, so the row and the segment cannot drift apart", () => {
    /* The registry joins on `segment.item_id === source.id`. Two modules
       deriving that id from the title separately is how a slug rule drifts and
       the join silently stops resolving. */
    const row = mintSegmentSource(entry(), "some--other-id", SHOW_META);
    expect(row!.id).toBe("some--other-id");
  });

  it("refuses an episode with no enclosure URL — there is nothing to play", () => {
    expect(mintSegmentSource(entry({ enclosure_url: undefined }), "x", SHOW_META)).toBeNull();
    expect(mintSegmentSource(entry({ enclosure_url: "   " }), "x", SHOW_META)).toBeNull();
  });

  it("refuses a non-https or tokened audio URL — the registry's own two lexical checks", () => {
    expect(mintSegmentSource(entry({ enclosure_url: "http://media.example/a.mp3" }), "x", SHOW_META)).toBeNull();
    expect(mintSegmentSource(entry({ enclosure_url: "https://media.example/a.mp3?token=abc123" }), "x", SHOW_META)).toBeNull();
    expect(mintSegmentSource(entry({ enclosure_url: "https://media.example/a.mp3?api_key=abc123" }), "x", SHOW_META)).toBeNull();
  });

  it("refuses an episode with no positive feed duration", () => {
    /* `check-forays.mjs` needs `duration_sec > 0`, and compares it against the
       minted segment's `reference_duration_sec` to within 2 s. A zero here is
       two errors, not one. */
    expect(mintSegmentSource(entry({ feed_duration_sec: undefined }), "x", SHOW_META)).toBeNull();
    expect(mintSegmentSource(entry({ feed_duration_sec: 0 }), "x", SHOW_META)).toBeNull();
  });

  it("refuses a show with no DAI verdict rather than defaulting it to false", () => {
    /* ADR-0007 gates seek precision on this flag, and `check-forays.mjs` says
       plainly that "a missing flag reads as falsy" — so an unknown verdict
       written as `false` is a claim nobody measured. MUTATION THAT KILLS THIS:
       `dai_suspected: meta?.dai ?? false`. */
    expect(mintSegmentSource(entry({ show_id: "no-verdict-show" }), "x", SHOW_META)).toBeNull();
    expect(mintSegmentSource(entry({ show_id: "a-show-nobody-swept" }), "x", SHOW_META)).toBeNull();
  });

  it("refuses an episode with no show or episode title — both must be non-empty strings", () => {
    expect(mintSegmentSource(entry({ title: "  " }), "x", SHOW_META)).toBeNull();
    expect(mintSegmentSource(entry({ show_title: "" }), "x", SHOW_META)).toBeNull();
  });

  it("reads the media type off the URL's own extension, ignoring the query string", () => {
    expect(enclosureMime("https://x/a.mp3")).toBe("audio/mpeg");
    expect(enclosureMime("https://x/a.m4a?aid=rss_feed")).toBe("audio/mp4");
    expect(enclosureMime("https://x/a.ogg")).toBe("audio/ogg");
    expect(enclosureMime("https://x/redirect/no-extension")).toBe("audio/mpeg");
  });

  it("reads the real catalogue: the sweep's verdict is the fallback, the resolved chain wins", () => {
    /* Against the committed files, not a fixture — the precedence mirrored from
       `prepare-segment-batch.mjs` is only worth anything if it agrees with the
       data those files actually hold. Practical AI is filed by the sweep AND
       resolved by `dai-classification.json` (apple id 1406537385). */
    const map = loadShowAudioMeta();
    const practical = map.get("practical-ai");
    expect(practical).toBeDefined();
    expect(typeof practical!.dai).toBe("boolean");
    expect(practical!.appleCollectionId).toBe(1406537385);
  });
});
