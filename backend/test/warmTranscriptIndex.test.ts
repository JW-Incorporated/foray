import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  corpusDigestRow,
  FEED_CACHE_MAX_AGE_MS,
  loadFeed,
  mergeCorpusRows,
  parseDuration,
  parseFeedEpisodes,
  parseWarmArgs,
  readCorpusDigestRows
} from "../src/cli/warmTranscriptIndex";

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

/* Round-3 audit, lane L6: backend-rest-8 (a --show warm keeps every other
   show's rows) and backend-rest-14 (the feed fetch is bounded and the cache
   expires). */
describe("mergeCorpusRows — a targeted warm never drops the rest of the archive (backend-rest-8)", () => {
  const r = (show_id: string, guid: string) => ({ show_id, show_title: show_id, guid, title: guid, cues: 1 });

  it("--show X replaces X's rows and keeps every other show's", () => {
    const existing = [r("a", "1"), r("x", "old"), r("b", "2")];
    const merged = mergeCorpusRows(existing, [r("x", "new")], ["x"]);
    expect(merged.map((e) => `${e.show_id}/${e.guid}`)).toEqual(["a/1", "b/2", "x/new"]);
  });

  it("a full warm is the whole truth: it replaces everything, and an empty result prunes stale rows", () => {
    expect(mergeCorpusRows([r("a", "1")], [r("b", "2")], [])).toEqual([r("b", "2")]);
    expect(mergeCorpusRows([r("a", "1")], [], [])).toEqual([]);
  });

  it("readCorpusDigestRows reads a digest file, and a missing or broken one is empty", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-digest-"));
    try {
      const file = path.join(dir, "corpus-digest.json");
      expect(readCorpusDigestRows(file)).toEqual([]);
      fs.writeFileSync(file, JSON.stringify({ transcripts: [r("a", "1")] }));
      expect(readCorpusDigestRows(file)).toEqual([r("a", "1")]);
      fs.writeFileSync(file, "{");
      expect(readCorpusDigestRows(file)).toEqual([]);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("loadFeed — bounded fetch, expiring cache (backend-rest-14)", () => {
  const feed = (...guids: string[]) =>
    `<rss><channel>${guids.map((g) => `<item><title>T ${g}</title><guid>${g}</guid><enclosure url="https://e.com/${g}.mp3"/></item>`).join("")}</channel></rss>`;
  const ok = (body: string) =>
    vi.fn().mockResolvedValue({ status: 200, ok: true, headers: { get: () => null }, text: async () => body } as unknown as Response);
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-feedcache-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const seed = (xml: string, ageMs: number) => {
    const file = path.join(dir, "show-a.xml");
    fs.writeFileSync(file, xml);
    const t = new Date(Date.now() - ageMs);
    fs.utimesSync(file, t, t);
  };

  it("a fresh cache that has every needed guid is used without a network call", async () => {
    seed(feed("g1"), 60_000);
    const fetchImpl = ok(feed("g1", "g2"));
    const byGuid = await loadFeed("show-a", "https://e.com/feed", false, { cacheDir: dir, fetchImpl, needGuids: ["g1"] });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect([...byGuid.keys()]).toEqual(["g1"]);
  });

  it("a cache older than the max age is refetched conditionally, through the bounded fetch (timeout signal, If-Modified-Since)", async () => {
    seed(feed("g1"), FEED_CACHE_MAX_AGE_MS + 60_000);
    const fetchImpl = ok(feed("g1", "g2"));
    const byGuid = await loadFeed("show-a", "https://e.com/feed", false, { cacheDir: dir, fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const init = fetchImpl.mock.calls[0]![1] as RequestInit & { headers: Record<string, string> };
    expect(init.signal).toBeDefined();
    expect(init.headers["If-Modified-Since"]).toBeDefined();
    expect([...byGuid.keys()].sort()).toEqual(["g1", "g2"]);
    expect(fs.readFileSync(path.join(dir, "show-a.xml"), "utf8")).toContain("g2");
  });

  it("a fresh cache missing a guid a pending body needs is refetched", async () => {
    seed(feed("g1"), 60_000);
    const fetchImpl = ok(feed("g1", "g2"));
    const byGuid = await loadFeed("show-a", "https://e.com/feed", false, { cacheDir: dir, fetchImpl, needGuids: ["g2"] });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(byGuid.has("g2")).toBe(true);
  });

  it("offline never fetches, and a failed refetch falls back to the cache", async () => {
    seed(feed("g1"), FEED_CACHE_MAX_AGE_MS + 60_000);
    const fetchImpl = ok(feed("g2"));
    expect([...(await loadFeed("show-a", "https://e.com/feed", true, { cacheDir: dir, fetchImpl })).keys()]).toEqual(["g1"]);
    expect(fetchImpl).not.toHaveBeenCalled();
    const failing = vi.fn().mockRejectedValue(new Error("network down"));
    expect([...(await loadFeed("show-a", "https://e.com/feed", false, { cacheDir: dir, fetchImpl: failing })).keys()]).toEqual(["g1"]);
  });
});

/* CH2-06 (B2-05): the warm pass reads feeds through `feeds/parser.ts`, the
   project's one RSS parser, instead of a private regex parser, duration parser
   and entity decoder. These pins go through `loadFeed` (offline, from a seeded
   cache) and `corpusDigestRow`, which is exactly the path a body takes on its
   way into corpus-digest.json, so they hold whichever parser sits underneath. */
describe("the digest row a feed produces (CH2-06)", () => {
  let dir = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-warmrow-"));
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  /** The feed as `loadFeed` reads it from the cache, never the network. */
  const episodesOf = async (xml: string) => {
    fs.writeFileSync(path.join(dir, "show-a.xml"), xml);
    return loadFeed("show-a", null, true, { cacheDir: dir });
  };
  const rss = (items: string) =>
    `<?xml version="1.0"?><rss xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd"><channel><title>Show level title, which is not an episode title</title>${items}</channel></rss>`;
  const item = (fields: { title?: string; guid?: string; enclosure?: string; duration?: string }) =>
    "<item>" +
    (fields.title !== undefined ? `<title>${fields.title}</title>` : "") +
    (fields.guid !== undefined ? `<guid isPermaLink="false">${fields.guid}</guid>` : "") +
    (fields.enclosure !== undefined ? `<enclosure url="${fields.enclosure}" length="1" type="audio/mpeg"/>` : "") +
    (fields.duration !== undefined ? `<itunes:duration>${fields.duration}</itunes:duration>` : "") +
    "</item>";
  const body = (guid: string) => ({ guid, cues: 12 });

  it("a plain title, a CDATA-wrapped guid and an hh:mm:ss duration make a complete, mintable row", async () => {
    /* MUTATION THAT KILLS THIS: drop the title, the enclosure (or its &amp;
       decoding) or the hh:mm:ss arithmetic from the feed parse — the row loses
       a field, or stops being mintable, with no error anywhere. */
    const feed = await episodesOf(
      rss(
        item({
          title: "Ep 7: The Long Way Round",
          guid: "<![CDATA[a1b2c3-cdata-guid]]>",
          enclosure: "https://traffic.example.com/ep7.mp3?t=1&amp;src=rss",
          duration: "01:02:34"
        })
      )
    );
    expect([...feed.keys()]).toEqual(["a1b2c3-cdata-guid"]);
    expect(corpusDigestRow("show-a", "Show A", body("a1b2c3-cdata-guid"), feed.get("a1b2c3-cdata-guid"))).toEqual({
      row: {
        show_id: "show-a",
        show_title: "Show A",
        guid: "a1b2c3-cdata-guid",
        title: "Ep 7: The Long Way Round",
        cues: 12,
        enclosure_url: "https://traffic.example.com/ep7.mp3?t=1&src=rss",
        feed_duration_sec: 3754
      },
      mintable: true
    });
  });

  it("reads mm:ss and bare seconds, takes the ITEM's title and finds the enclosure url wherever the attribute sits", async () => {
    /* MUTATION THAT KILLS THIS: read "58:21" as 58 (an episode that ranks and
       then yields nothing past 58 s), or take the channel's title. */
    const feed = await episodesOf(
      rss(
        `<item><title><![CDATA[Ep 1: Cholera & the Broad Street pump]]></title><guid>g1</guid>` +
          `<enclosure type="audio/mpeg" url="https://example.com/one.mp3"/><itunes:duration>58:21</itunes:duration></item>` +
          item({ title: "Ep 2", guid: "g2", enclosure: "https://example.com/two.mp3", duration: "3501" })
      )
    );
    expect(feed.get("g1")).toEqual({
      guid: "g1",
      title: "Ep 1: Cholera & the Broad Street pump",
      enclosureUrl: "https://example.com/one.mp3",
      durationSec: 3501
    });
    expect(feed.get("g2")?.durationSec).toBe(3501);
  });

  it("drops an item with no guid rather than inventing a row nothing can join to, and reads nothing from a non-feed", async () => {
    /* MUTATION THAT KILLS THIS: key a guid-less item on "" or on its position
       — a phantom episode in the searchable archive. */
    const feed = await episodesOf(
      rss(item({ title: "No guid, so no row", enclosure: "https://example.com/three.mp3", duration: "60" }) + item({ title: "Kept", guid: "g9" }))
    );
    expect([...feed.keys()]).toEqual(["g9"]);
    expect((await episodesOf("not xml at all")).size).toBe(0);
    expect((await episodesOf("")).size).toBe(0);
  });

  it("a body the feed does not carry is searchable only, titled by its guid", () => {
    /* MUTATION THAT KILLS THIS: invent a title, or count a row with no feed
       metadata as mintable. */
    expect(corpusDigestRow("show-a", "Show A", body("orphan"), undefined)).toEqual({
      row: { show_id: "show-a", show_title: "Show A", guid: "orphan", title: "orphan", cues: 12 },
      mintable: false
    });
  });

  it("a duration of 0 or junk never writes feed_duration_sec and never counts mintable", async () => {
    /* MUTATION THAT KILLS THIS: let a 0 or unparseable duration through as a
       number — mintSegmentSource would take it as real and refuse later. */
    const feed = await episodesOf(
      rss(
        item({ title: "Zero", guid: "z", enclosure: "https://e.com/z.mp3", duration: "0" }) +
          item({ title: "Junk", guid: "j", enclosure: "https://e.com/j.mp3", duration: "unknown" })
      )
    );
    for (const guid of ["z", "j"]) {
      const { row, mintable } = corpusDigestRow("show-a", "Show A", body(guid), feed.get(guid));
      expect(row.feed_duration_sec).toBeUndefined();
      expect(row.enclosure_url).toBe(`https://e.com/${guid}.mp3`);
      expect(mintable).toBe(false);
    }
  });

  it("an item with no <title> is never given an invented one, and is not mintable", async () => {
    /* MUTATION THAT KILLS THIS: take the shared parser's "(untitled item #N)"
       placeholder as the episode's title — the Foray would carry a made-up
       episode name and the row would count as mintable. */
    const feed = await episodesOf(rss(item({ guid: "nt", enclosure: "https://e.com/nt.mp3", duration: "600" })));
    const { row, mintable } = corpusDigestRow("show-a", "Show A", body("nt"), feed.get("nt"));
    expect(row.title).toBe("");
    expect(mintable).toBe(false);
  });

  it("the join key is byte-equal to the guid tools/segments/sweep-transcripts.mjs extracts (CDATA, padded CDATA, &amp;, plain)", async () => {
    /* The digest row joins a body on disk by guid, and the body's guid was
       read by sweep-transcripts' regex parser. MUTATION THAT KILLS THIS: a
       guid rule change in either parser (stop stripping CDATA, stop trimming,
       stop decoding &amp;) silently turns every row of a show searchable-only. */
    const guids = ["<![CDATA[a1b2c3-cdata-guid]]>", "<![CDATA[  padded-cdata  ]]>", "https://example.com/?p=1&amp;q=2", "plain-guid-123"];
    const xml = rss(guids.map((g, i) => item({ title: `T${i}`, guid: g, enclosure: `https://e.com/${i}.mp3` })).join(""));
    const sweep = (await import("../../tools/segments/sweep-transcripts.mjs")) as {
      parseFeed: (xml: string) => { episodes: Array<{ guid: string }> };
    };
    const swept = sweep.parseFeed(xml).episodes.map((e) => e.guid);
    expect(swept).toEqual(["a1b2c3-cdata-guid", "padded-cdata", "https://example.com/?p=1&q=2", "plain-guid-123"]);
    expect([...(await episodesOf(xml)).keys()]).toEqual(swept);
  });
});
