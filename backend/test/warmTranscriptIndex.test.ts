import { describe, it, expect } from "vitest";
import { parseFeedEpisodes, parseDuration, parseWarmArgs } from "../src/cli/warmTranscriptIndex";

/**
 * Issue #703 — the warm pass's own parsing, which is what decides whether a
 * reconciled episode is SEARCHABLE only or also MINTABLE.
 *
 * Why this matters more than it looks: a body on disk knows its show and its
 * guid and nothing else. `audioSourceLookup.mintSegmentSource` refuses a row
 * without a title, an https enclosure and a positive duration, so every one of
 * those three fields is the difference between a Foray that can play a clip
 * from `This Podcast Will Kill You` and one that can only read about it. The
 * feed is where all three come from.
 *
 * KILLING MUTATIONS THIS SUITE CATCHES:
 *
 *  1. `parseFeedEpisodes` losing the enclosure URL, the title or the guid — any
 *     one of which silently downgrades every episode of a show to
 *     searchable-only, with no error anywhere.
 *  2. It accepting an item with no guid, which would produce a digest row that
 *     can never be joined to a body and therefore a phantom episode in the
 *     searchable archive.
 *  3. `parseDuration` reading "58:21" as 58 — the published form most feeds
 *     use. A duration of 58 seconds makes §4.5 refuse every window past that
 *     mark as `past-duration`, so the episode indexes, ranks, and then yields
 *     nothing, which is the hardest failure of all to read.
 *  4. `parseDuration` returning 0 rather than null for junk, which
 *     `mintSegmentSource` would take as a real duration and refuse later.
 *  5. `parseWarmArgs` silently ignoring `--show`, turning a targeted warm of one
 *     show into a full 449 MB pass on a 16 GB machine with other agents on it.
 */
describe("parseFeedEpisodes takes the three fields a body file does not have", () => {
  const FEED = `<?xml version="1.0"?><rss><channel>
    <title>Show level title, which is not an episode title</title>
    <item>
      <title><![CDATA[Ep 1: Cholera & the Broad Street pump]]></title>
      <guid isPermaLink="false">d5981d2b-6850-4830-bc2a-b4b201569e3e</guid>
      <enclosure url="https://traffic.omny.fm/d/clips/one.mp3?t=1" length="1" type="audio/mpeg"/>
      <itunes:duration>3501</itunes:duration>
    </item>
    <item>
      <title>Ep 2: Semmelweis</title>
      <guid>https://example.com/p/2</guid>
      <enclosure type="audio/mpeg" url="https://example.com/two.mp3"/>
      <itunes:duration>58:21</itunes:duration>
    </item>
    <item>
      <title>No guid, so no row</title>
      <enclosure url="https://example.com/three.mp3"/>
    </item>
  </channel></rss>`;

  it("reads guid, episode title, enclosure and duration for every item that has a guid", () => {
    const episodes = parseFeedEpisodes(FEED);
    expect(episodes).toHaveLength(2);
    expect(episodes[0]).toEqual({
      guid: "d5981d2b-6850-4830-bc2a-b4b201569e3e",
      title: "Ep 1: Cholera & the Broad Street pump",
      enclosureUrl: "https://traffic.omny.fm/d/clips/one.mp3?t=1",
      durationSec: 3501
    });
  });

  it("finds the enclosure url wherever the attribute sits, not only first", () => {
    expect(parseFeedEpisodes(FEED)[1]?.enclosureUrl).toBe("https://example.com/two.mp3");
  });

  it("takes the ITEM's title, never the channel's", () => {
    expect(parseFeedEpisodes(FEED)[0]?.title).not.toContain("Show level title");
  });

  it("drops an item with no guid rather than inventing a row nothing can join to", () => {
    expect(parseFeedEpisodes(FEED).map((e) => e.title)).not.toContain("No guid, so no row");
  });

  it("returns nothing for a feed that is not one, instead of throwing mid-warm", () => {
    expect(parseFeedEpisodes("not xml at all")).toEqual([]);
    expect(parseFeedEpisodes("")).toEqual([]);
  });
});

describe("parseDuration understands the three forms podcasts publish", () => {
  it("reads bare seconds", () => {
    expect(parseDuration("3501")).toBe(3501);
  });

  it("reads mm:ss as minutes, not as its first number", () => {
    expect(parseDuration("58:21")).toBe(3501);
  });

  it("reads hh:mm:ss", () => {
    expect(parseDuration("01:02:34")).toBe(3754);
  });

  it("returns null — never 0 — for junk, so a row stays honestly unmintable", () => {
    expect(parseDuration("unknown")).toBeNull();
    expect(parseDuration("0")).toBeNull();
    expect(parseDuration("-5")).toBeNull();
    expect(parseDuration(null)).toBeNull();
  });
});

describe("parseWarmArgs", () => {
  it("collects every --show so a targeted warm stays targeted", () => {
    expect(parseWarmArgs(["--show", "a", "--show", "b"]).shows).toEqual(["a", "b"]);
  });

  it("defaults to the whole corpus, online, both phases", () => {
    expect(parseWarmArgs([])).toEqual({ offline: false, shows: [], reconcileOnly: false, buildOnly: false });
  });

  it("reads the three flags that bound the work", () => {
    const args = parseWarmArgs(["--offline", "--reconcile-only", "--build-only"]);
    expect(args.offline).toBe(true);
    expect(args.reconcileOnly).toBe(true);
    expect(args.buildOnly).toBe(true);
  });

  it("ignores a trailing --show with nothing after it rather than warming a show called undefined", () => {
    expect(parseWarmArgs(["--show"]).shows).toEqual([]);
  });
});
