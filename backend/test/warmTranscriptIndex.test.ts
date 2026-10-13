import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import {
  anyWarmMode,
  buildSupplyReport,
  corpusDigestRow,
  FEED_CACHE_MAX_AGE_MS,
  loadFeed,
  mergeCorpusRows,
  mergeStagedRows,
  mintRefusal,
  parseWarmArgs,
  parseWarmModes,
  readCorpusDigestRows,
  readLegacyKeys,
  readLegacyMapExport,
  readStagedRows,
  runFromStaged,
  runResolveLegacy,
  runSupplyReport,
  supplyReportTable,
  type CatalogueShows,
  type LegacyMapReport
} from "../src/cli/warmTranscriptIndex";
import type { ShowAudioMeta } from "../src/generation/audioSourceLookup";
import type { TranscriptDigestEntry } from "../src/generation/transcriptArchiveLookup";

/**
 * Issue #703 — the warm pass's feed join, which is what decides whether a
 * reconciled episode is SEARCHABLE only or also MINTABLE.
 *
 * Why this matters more than it looks: a body on disk knows its show and its
 * guid and nothing else. `audioSourceLookup.mintSegmentSource` refuses a row
 * without a title, an https enclosure and a positive duration, so every one of
 * those three fields is the difference between a Foray that can play a clip
 * from `This Podcast Will Kill You` and one that can only read about it. The
 * feed is where all three come from.
 *
 * The feed is read by `feeds/parser.ts`, the project's one RSS parser
 * (CH2-06); the pins for it live in the "digest row" block at the end, which
 * goes through `loadFeed` and `corpusDigestRow` — the path a body takes into
 * corpus-digest.json.
 *
 * KILLING MUTATIONS THIS SUITE CATCHES:
 *
 *  1. The feed parse losing the enclosure URL, the title or the guid — any
 *     one of which silently downgrades every episode of a show to
 *     searchable-only, with no error anywhere.
 *  2. It accepting an item with no guid, which would produce a digest row that
 *     can never be joined to a body and therefore a phantom episode in the
 *     searchable archive.
 *  3. A duration of "58:21" read as 58 — the published form most feeds use.
 *     A duration of 58 seconds makes §4.5 refuse every window past that mark
 *     as `past-duration`, so the episode indexes, ranks, and then yields
 *     nothing, which is the hardest failure of all to read.
 *  4. A 0 or junk duration written as a real one, which `mintSegmentSource`
 *     would take as a real duration and refuse later.
 *  5. `parseWarmArgs` silently ignoring `--show`, turning a targeted warm of one
 *     show into a full 449 MB pass on a 16 GB machine with other agents on it.
 *  6. The private regex parser, duration parser or entity decoder coming back
 *     (CH2-06): `Rockets &#038; Rails` stored literally, `12:75` mintable.
 *  7. A guid rule change in this parse or in sweep-transcripts.mjs's, which
 *     breaks the body join.
 */
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

  it("an entity-encoded title is decoded the way every other feed reader here decodes it (Rockets &#038; Rails)", async () => {
    /* RED before CH2-06: the private decodeXml knew five named entities and
       stored `Rockets &#038; Rails` literally in corpus-digest.json, from where
       it rode into the published Foray's segment source. MUTATION THAT KILLS
       THIS: put the private decoder back. */
    const feed = await episodesOf(rss(item({ title: "Rockets &#038; Rails", guid: "rr", enclosure: "https://e.com/rr.mp3", duration: "1200" })));
    expect(corpusDigestRow("show-a", "Show A", body("rr"), feed.get("rr")).row.title).toBe("Rockets & Rails");
  });

  it("an out-of-range duration (12:75) is unresolved, so the row is searchable only", async () => {
    /* RED before CH2-06: the private parseDuration read `12:75` as 795 s and
       counted the row mintable. `feeds/duration.ts` calls it garbage
       (out-of-range-component). MUTATION THAT KILLS THIS: put the private
       duration parser back. */
    const feed = await episodesOf(rss(item({ title: "Bad clock", guid: "bc", enclosure: "https://e.com/bc.mp3", duration: "12:75" })));
    expect(feed.get("bc")?.durationSec).toBeNull();
    const { row, mintable } = corpusDigestRow("show-a", "Show A", body("bc"), feed.get("bc"));
    expect(row.feed_duration_sec).toBeUndefined();
    expect(mintable).toBe(false);
  });
});

/* GV-53 (docs/roadmap/generation-v2.md, from W3-03): digest rows for streamed
   episodes. Three opt-in modes, each driven here offline, over the fixtures in
   test/fixtures/warm/ (a staged digest as GV-05 writes it, and cached feeds
   keyed by show id) with an injected catalogue, an injected feed cache dir,
   a tmp corpus digest and a fetch spy that must stay silent offline.

   KILLING MUTATIONS (each run against this suite; see the PR body):
    G1. --from-staged rewrites a row a COMMITTED digest already describes
        (drop the claimedFiles test in joinStagedRows).
    G2. --from-staged downgrades an existing mintable corpus row with a
        searchable-only re-join (drop the hasFeedMetadata guard).
    G3. --from-staged prunes other shows' rows (merge by replacing instead of
        by key).
    G4. --offline reaches the network (pass `false` for offline to loadFeed).
    G5. --legacy-map-from loses to the feed (check overrides after the RSS
        resolution instead of before).
    G6. a show slug that names no catalogue show is resolved anyway (match the
        slug by prefix instead of exactly).
    G7. --supply-report names a later condition first (reorder
        MINT_CONDITIONS).
    G8. --supply-report counts a row of a show with no lineage as mintable
        (drop the lineage check in mintRefusal). */
const WARM_FIXTURES = path.join(__dirname, "fixtures", "warm");
const STAGED_FIXTURE = path.join(WARM_FIXTURES, "staged-digest.jsonl");
const FEED_SAMPLE = JSON.parse(fs.readFileSync(path.join(WARM_FIXTURES, "feed-cache-sample.json"), "utf8")) as Record<string, string>;

const CATALOGUE: CatalogueShows = new Map([
  ["fixture-show", { title: "Fixture Show", feedUrl: "https://feeds.example.com/fixture.xml" }],
  ["the-legacy-show-id", { title: "The Legacy Show", feedUrl: "https://feeds.example.com/legacy.xml" }],
  ["no-feed-show", { title: "No Feed Show", feedUrl: null }],
  ["no-cache-show", { title: "No Cache Show", feedUrl: "https://feeds.example.com/no-cache.xml" }],
  ["twin-a", { title: "Twin Show", feedUrl: null }],
  ["twin-b", { title: "Twin Show!", feedUrl: null }]
]);

/** A fetch spy that rejects if it is ever reached. */
const silentFetch = () => vi.fn().mockRejectedValue(new Error("network must not be touched"));
const okFetch = (body: string) =>
  vi.fn().mockResolvedValue({ status: 200, ok: true, headers: { get: () => null }, text: async () => body } as unknown as Response);

describe("GV-53 modes — parseWarmModes", () => {
  it("no mode by default, so the default warm runs unchanged", () => {
    const modes = parseWarmModes(["--offline", "--show", "a"]);
    expect(modes).toEqual({ fromStaged: null, resolveLegacy: null, legacyMapFrom: null, supplyReport: false });
    expect(anyWarmMode(modes)).toBe(false);
  });

  it("reads each mode and its file, and a flag with no value is no mode", () => {
    const modes = parseWarmModes(["--from-staged", "s.jsonl", "--resolve-legacy", "k.txt", "--legacy-map-from", "m.json", "--supply-report"]);
    expect(modes).toEqual({ fromStaged: "s.jsonl", resolveLegacy: "k.txt", legacyMapFrom: "m.json", supplyReport: true });
    expect(anyWarmMode(parseWarmModes(["--supply-report"]))).toBe(true);
    expect(parseWarmModes(["--from-staged", "--offline"]).fromStaged).toBeNull();
  });
});

describe("GV-53 --from-staged — staged rows joined to their feeds", () => {
  let dir = "";
  let cacheDir = "";
  let committed = "";
  let corpusDigest = "";
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-staged-"));
    cacheDir = path.join(dir, "feeds");
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, "fixture-show.xml"), FEED_SAMPLE["fixture-show"]!);
    committed = path.join(dir, "transcript-digests.json");
    fs.writeFileSync(
      committed,
      JSON.stringify({ transcripts: [{ show_id: "fixture-show", show_title: "Fixture Show", guid: "g-claimed", title: "Committed title", cues: 9 }] })
    );
    corpusDigest = path.join(dir, "corpus-digest.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const run = (extra: Partial<Parameters<typeof runFromStaged>[0]> = {}) =>
    runFromStaged({
      stagedFile: STAGED_FIXTURE,
      corpusDigest,
      committedDigests: [committed],
      catalogue: CATALOGUE,
      feedCacheDir: cacheDir,
      offline: true,
      fetchImpl: silentFetch(),
      ...extra
    });
  const rowsByGuid = () => new Map(readCorpusDigestRows(corpusDigest).map((r) => [r.guid, r]));

  it("readStagedRows keeps GV-05's rows and names every line it could not use", () => {
    const { rows, problems } = readStagedRows(STAGED_FIXTURE);
    expect(rows.map((r) => r.guid)).toEqual(["g-mint", "g-nofeed", "g-claimed", "u-1", "g-mint"]);
    expect(problems).toEqual(["line 6: no show_id or guid", "line 7: not JSON", "line 8: no cues"]);
  });

  it("a feed episode makes a mintable row with enclosure_url and feed_duration_sec; a guid the feed lacks stays searchable only", async () => {
    const result = await run();
    const rows = rowsByGuid();
    expect(rows.get("g-mint")).toEqual({
      show_id: "fixture-show",
      show_title: "Fixture Show",
      guid: "g-mint",
      title: "Ep 1: Mintable",
      cues: 40,
      enclosure_url: "https://cdn.example.com/fixture/g-mint.mp3",
      feed_duration_sec: 2530
    });
    expect(rows.get("g-nofeed")).toEqual({ show_id: "fixture-show", show_title: "Fixture Show", guid: "g-nofeed", title: "g-nofeed", cues: 12 });
    /* No catalogue row, no feed: searchable only, titled as it was staged. */
    expect(rows.get("u-1")).toEqual({ show_id: "uncatalogued-show", show_title: "uncatalogued-show", guid: "u-1", title: "u-1", cues: 7 });
    expect(result.perShow).toEqual([
      { showId: "fixture-show", added: 2, mintable: 1, searchableOnly: 1 },
      { showId: "uncatalogued-show", added: 1, mintable: 0, searchableOnly: 1 }
    ]);
    expect(result.duplicates).toBe(1);
    expect(result.problems).toHaveLength(3);
    const written = JSON.parse(fs.readFileSync(corpusDigest, "utf8")) as { summary: { transcripts: number }; policy: string };
    expect(written.summary.transcripts).toBe(3);
    expect(written.policy).toContain("--from-staged");
  });

  it("a committed row is never overwritten, other shows' rows are kept, and a mintable row is never downgraded", async () => {
    /* G1, G2, G3. The existing corpus digest holds another show's row and a
       mintable g-nofeed row from an earlier online join; this offline run's
       cached feed lacks g-nofeed. */
    const earlier = {
      show_id: "fixture-show",
      show_title: "Fixture Show",
      guid: "g-nofeed",
      title: "Ep 2",
      cues: 12,
      enclosure_url: "https://cdn.example.com/2.mp3",
      feed_duration_sec: 900
    };
    const other = { show_id: "another-show", show_title: "Another", guid: "a-1", title: "A", cues: 3 };
    fs.writeFileSync(corpusDigest, JSON.stringify({ transcripts: [earlier, other] }));
    const result = await run();
    const rows = rowsByGuid();
    expect(rows.has("g-claimed")).toBe(false);
    expect(result.claimed).toBe(1);
    expect(rows.get("a-1")).toEqual(other);
    expect(rows.get("g-nofeed")).toEqual(earlier);
    expect([...rows.keys()]).toEqual(["a-1", "g-mint", "g-nofeed", "u-1"]);
  });

  it("mergeStagedRows lets a re-join upgrade a searchable-only row", () => {
    const searchable = { show_id: "s", show_title: "S", guid: "g", title: "g", cues: 1 };
    const minted = { ...searchable, title: "T", enclosure_url: "https://e.com/g.mp3", feed_duration_sec: 60 };
    expect(mergeStagedRows([searchable], [minted])).toEqual([minted]);
    expect(mergeStagedRows([minted], [searchable])).toEqual([minted]);
  });

  it("--offline makes no network call even when the cache lacks a staged guid; online, that same gap is refetched", async () => {
    /* G4. Online, the missing g-nofeed forces a conditional refetch of
       fixture-show's feed (uncatalogued-show has no feed_url, so no call). */
    const offlineFetch = silentFetch();
    await run({ fetchImpl: offlineFetch });
    expect(offlineFetch).not.toHaveBeenCalled();

    const refreshed = FEED_SAMPLE["fixture-show"]!.replace(
      "</channel>",
      '<item><title>Ep 2: Found</title><guid>g-nofeed</guid><enclosure url="https://cdn.example.com/fixture/g-nofeed.mp3"/><itunes:duration>900</itunes:duration></item></channel>'
    );
    const onlineFetch = okFetch(refreshed);
    fs.rmSync(corpusDigest, { force: true });
    const result = await run({ offline: false, fetchImpl: onlineFetch });
    expect(onlineFetch.mock.calls.map((c) => c[0])).toEqual(["https://feeds.example.com/fixture.xml"]);
    expect(rowsByGuid().get("g-nofeed")?.feed_duration_sec).toBe(900);
    expect(result.perShow[0]).toEqual({ showId: "fixture-show", added: 2, mintable: 2, searchableOnly: 0 });
  });
});

describe("GV-53 --resolve-legacy — legacy whisper keys to show_id and guid", () => {
  let dir = "";
  let cacheDir = "";
  let keysFile = "";
  let out = "";
  const KEYS = {
    matched: "the-legacy-show/episode-one-965c8d5411.json",
    ambiguous: "the-legacy-show/f400d5dd07.json",
    noHash: "the-legacy-show/lost-episode-0123456789.json",
    noShow: "unknown-show/x-0123456789.json",
    prefixOnly: "the-legacy/x-965c8d5411.json",
    noFeed: "no-feed-show/x-abcdefabcd.json",
    noCache: "no-cache-show/x-abcdefabcd.json",
    twin: "twin-show/x-abcdefabcd.json",
    notLegacy: "transcripts/abc/def.json"
  };
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-legacy-"));
    cacheDir = path.join(dir, "feeds");
    fs.mkdirSync(cacheDir);
    fs.writeFileSync(path.join(cacheDir, "the-legacy-show-id.xml"), FEED_SAMPLE["the-legacy-show-id"]!);
    keysFile = path.join(dir, "keys.txt");
    fs.writeFileSync(keysFile, `# legacy keys\n${Object.values(KEYS).join("\n")}\n\n${KEYS.matched}\n`);
    out = path.join(dir, "legacy-map.json");
  });
  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const resolve = (extra: Partial<Parameters<typeof runResolveLegacy>[0]> = {}) =>
    runResolveLegacy({ keysFile, out, catalogue: CATALOGUE, feedCacheDir: cacheDir, offline: true, fetchImpl: silentFetch(), ...extra });

  it("readLegacyKeys skips blanks, comments and repeats", () => {
    expect(readLegacyKeys(keysFile)).toEqual(Object.values(KEYS));
  });

  it("matches sha1(guid)[:10] through the catalogue title slug, and reports ambiguous and unmatched with reasons", async () => {
    /* G6. The matched key's hash is sha1("leg-guid-1")[:10]; f400d5dd07 is
       the shared prefix of the fixture's two brute-forced twin guids. The
       resolver is GV-23's, loaded by dynamic import from tools/. */
    const report = await resolve();
    expect(report.map).toEqual({ [KEYS.matched]: { show_id: "the-legacy-show-id", guid: "leg-guid-1", title: "Episode One", via: "rss" } });
    expect(report.unresolved).toEqual({
      [KEYS.ambiguous]: { status: "ambiguous", reason: "guid_hash_multi_episode", show_id: "the-legacy-show-id" },
      [KEYS.noHash]: { status: "unmatched", reason: "no_episode_for_guid_hash", show_id: "the-legacy-show-id" },
      [KEYS.noShow]: { status: "unmatched", reason: "show_not_in_catalog", show_id: null },
      [KEYS.prefixOnly]: { status: "unmatched", reason: "show_not_in_catalog", show_id: null },
      [KEYS.noFeed]: { status: "unmatched", reason: "no_feed", show_id: "no-feed-show" },
      [KEYS.noCache]: { status: "unmatched", reason: "no_feed", show_id: "no-cache-show" },
      [KEYS.twin]: { status: "ambiguous", reason: "show_slug_multi_show", show_id: null },
      [KEYS.notLegacy]: { status: "unmatched", reason: "not_a_legacy_key", show_id: null }
    });
    expect(report.counts).toEqual({
      keys: 9,
      byStatus: { matched: 1, ambiguous: 2, unmatched: 6 },
      byReason: {
        guid_hash_multi_episode: 1,
        no_episode_for_guid_hash: 1,
        show_not_in_catalog: 2,
        no_feed: 2,
        show_slug_multi_show: 1,
        not_a_legacy_key: 1
      },
      byVia: { rss: 1, "foray-db": 0 }
    });
    expect((JSON.parse(fs.readFileSync(out, "utf8")) as LegacyMapReport).map).toEqual(report.map);
  });

  it("--legacy-map-from entries override RSS resolution, and resolve keys the feed cannot", async () => {
    /* G5. */
    const exported = path.join(dir, "foray-db-map.json");
    fs.writeFileSync(
      exported,
      JSON.stringify([
        { normalized_key: KEYS.matched, show_id: "the-legacy-show-id", guid: "db-guid-1", title: "From foray-db" },
        { normalized_key: KEYS.noShow, show_id: "unknown-show", guid: "db-guid-2" },
        { normalized_key: "bad-row/x-0000000000.json", show_id: "x" }
      ])
    );
    expect([...readLegacyMapExport(exported).keys()]).toEqual([KEYS.matched, KEYS.noShow]);
    const report = await resolve({ legacyMapFrom: exported });
    expect(report.map[KEYS.matched]).toEqual({ show_id: "the-legacy-show-id", guid: "db-guid-1", title: "From foray-db", via: "foray-db" });
    expect(report.map[KEYS.noShow]).toEqual({ show_id: "unknown-show", guid: "db-guid-2", title: "", via: "foray-db" });
    expect(report.counts.byVia).toEqual({ rss: 0, "foray-db": 2 });
    /* The keyed-object export shape reads the same. */
    fs.writeFileSync(exported, JSON.stringify({ [KEYS.noFeed]: { show_id: "no-feed-show", guid: "db-3", title: "T" } }));
    expect(readLegacyMapExport(exported).get(KEYS.noFeed)).toEqual({ show_id: "no-feed-show", guid: "db-3", title: "T" });
  });

  it("--offline makes no network call for a show with a feed_url and no cache; online, it would fetch", async () => {
    /* G4. */
    const offlineFetch = silentFetch();
    await resolve({ fetchImpl: offlineFetch });
    expect(offlineFetch).not.toHaveBeenCalled();
    const onlineFetch = okFetch("<rss><channel></channel></rss>");
    await resolve({ offline: false, fetchImpl: onlineFetch });
    expect(onlineFetch.mock.calls.map((c) => c[0])).toEqual(["https://feeds.example.com/no-cache.xml"]);
  });
});

describe("GV-53 --supply-report — searchable vs mintable, per show", () => {
  const row = (show_id: string, guid: string, extra: Partial<TranscriptDigestEntry> = {}): TranscriptDigestEntry => ({
    show_id,
    show_title: show_id,
    guid,
    title: `T ${guid}`,
    cues: 5,
    ...extra
  });
  const full = { enclosure_url: "https://e.com/a.mp3", feed_duration_sec: 600 };
  const meta = (dai: boolean | null): ShowAudioMeta => ({ dai, feedUrl: null, appleCollectionId: null });
  const showMeta = new Map<string, ShowAudioMeta>([
    ["no-dai", meta(null)],
    ["no-enc", meta(false)],
    ["no-dur", meta(false)],
    ["mixed", meta(true)],
    ["full", meta(false)],
    ["off-catalogue", meta(false)]
  ]);
  const lineage = new Set(["no-dai", "no-enc", "no-dur", "mixed", "full"]);
  const archive = [
    row("off-catalogue", "o1", full),
    row("no-dai", "d1", full),
    row("no-enc", "e1", { feed_duration_sec: 600 }),
    row("no-enc", "e2", { enclosure_url: "http://insecure.example.com/e2.mp3", feed_duration_sec: 600 }),
    row("no-dur", "u1", { enclosure_url: "https://e.com/u1.mp3" }),
    row("mixed", "m1", full),
    row("mixed", "m2", { feed_duration_sec: 600 }),
    row("mixed", "m3", { enclosure_url: "https://e.com/m3.mp3" }),
    row("mixed", "m4", { ...full, title: " " }),
    row("full", "f1", full),
    row("full", "f2", full)
  ];
  const opts = { hasLineage: (e: TranscriptDigestEntry) => lineage.has(e.show_id), showMeta, now: () => new Date("2026-10-13T00:00:00Z") };

  it("names the first missing mint condition for each show, and counts searchable and mintable rows", () => {
    /* G7, G8. */
    const report = buildSupplyReport(archive, opts);
    const byShow = Object.fromEntries(report.shows.map((s) => [s.show_id, [s.rows, s.searchable, s.mintable, s.reason_not_mintable]]));
    expect(byShow).toEqual({
      "off-catalogue": [1, 0, 0, "not-in-catalog"],
      "no-dai": [1, 1, 0, "no-dai-verdict"],
      "no-enc": [2, 2, 0, "no-enclosure"],
      "no-dur": [1, 1, 0, "no-duration"],
      mixed: [4, 4, 1, "no-enclosure"],
      full: [2, 2, 2, null]
    });
    expect(report.shows.find((s) => s.show_id === "mixed")?.reasons).toEqual({ "no-enclosure": 1, "no-duration": 1, "no-title": 1 });
    expect(report.totals).toEqual({ shows: 6, rows: 11, searchable: 10, mintable: 3, searchableOnlyShows: 3 });
  });

  it("mintRefusal follows the mint order: lineage, DAI verdict, enclosure, duration, title", () => {
    expect(mintRefusal(row("no-dai", "x"), false, showMeta)).toBe("not-in-catalog");
    expect(mintRefusal(row("no-dai", "x"), true, showMeta)).toBe("no-dai-verdict");
    expect(mintRefusal(row("full", "x"), true, showMeta)).toBe("no-enclosure");
    expect(mintRefusal(row("full", "x", { enclosure_url: "https://e.com/a.mp3?token=s", feed_duration_sec: 5 }), true, showMeta)).toBe("no-enclosure");
    expect(mintRefusal(row("full", "x", { enclosure_url: "https://e.com/a.mp3" }), true, showMeta)).toBe("no-duration");
    expect(mintRefusal(row("full", "x", { ...full, title: "" }), true, showMeta)).toBe("no-title");
    expect(mintRefusal(row("full", "x", full), true, showMeta)).toBeNull();
  });

  it("prints a table and writes the report as JSON", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "foray-supply-"));
    try {
      const out = path.join(dir, "supply-report.json");
      const report = runSupplyReport({ ...opts, archive, out });
      expect(JSON.parse(fs.readFileSync(out, "utf8"))).toEqual(report);
      const table = supplyReportTable(report);
      expect(table.split("\n")[0]).toMatch(/^show\s+rows\s+searchable\s+mintable\s+first missing$/);
      expect(table).toMatch(/off-catalogue\s+1\s+0\s+0\s+not-in-catalog/);
      expect(table).toMatch(/full\s+2\s+2\s+2\s+-/);
      expect(table).toContain("3 show(s) searchable but unable to supply a clip");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("by default a show with no taxonomy lineage in the repo's catalogue is never searchable", () => {
    const report = buildSupplyReport([row("gv53-no-such-show", "g", full)], { showMeta });
    expect(report.shows[0]).toMatchObject({ searchable: 0, mintable: 0, reason_not_mintable: "not-in-catalog" });
  });
});
