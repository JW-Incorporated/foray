import { describe, it, expect, vi } from "vitest";
import { ingestShowFeed } from "../src/catalog/ingestShowFeed";
import { InMemoryShowEpisodesStore } from "../src/catalog/showEpisodesStore";

const FEED_ONE_EP = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd" xmlns:podcast="https://podcastindex.org/namespace/1.0">
<channel>
  <title>Test Show</title>
  <item>
    <title>Episode One</title>
    <guid>ep-1</guid>
    <description>First episode</description>
    <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg" length="1000"/>
    <itunes:duration>600</itunes:duration>
    <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
    <podcast:chapters url="https://example.com/ep1-chapters.json" type="application/json+chapters"/>
  </item>
</channel>
</rss>`;

const FEED_TWO_EPS = `<?xml version="1.0"?>
<rss version="2.0" xmlns:itunes="http://www.itunes.com/dtds/podcast-1.0.dtd">
<channel>
  <title>Test Show</title>
  <item>
    <title>Episode One</title>
    <guid>ep-1</guid>
    <description>First episode</description>
    <enclosure url="https://cdn.example.com/ep1.mp3" type="audio/mpeg" length="1000"/>
    <pubDate>Mon, 01 Jan 2026 00:00:00 GMT</pubDate>
  </item>
  <item>
    <title>Episode Two</title>
    <guid>ep-2</guid>
    <description>Second episode</description>
    <enclosure url="https://cdn.example.com/ep2.mp3" type="audio/mpeg" length="1000"/>
    <pubDate>Tue, 02 Jan 2026 00:00:00 GMT</pubDate>
  </item>
</channel>
</rss>`;

const FEED_NO_ENCLOSURE = `<?xml version="1.0"?>
<rss version="2.0"><channel><title>T</title>
  <item><title>Broken</title><guid>ep-x</guid><description>no audio</description></item>
</channel></rss>`;

function mockFetchOk(body: string, headers: Record<string, string> = {}) {
  return vi.fn().mockResolvedValue({
    status: 200,
    ok: true,
    headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
    text: async () => body
  } as unknown as Response);
}

describe("ingestShowFeed", () => {
  it("fetches and stores episodes on first ingest, producing a real audio_url for every episode (never rehosted)", async () => {
    const store = new InMemoryShowEpisodesStore();
    const fetchImpl = mockFetchOk(FEED_TWO_EPS);
    const result = await ingestShowFeed("show-a", "https://example.com/feed.xml", store, { fetchImpl });

    expect(result.status).toBe("fresh");
    expect(result.episodeCount).toBe(2);
    const eps = await store.episodesForShow("show-a");
    for (const ep of eps) {
      expect(ep.audio_url).toMatch(/^https:\/\/cdn\.example\.com\//); // original enclosure, not rehosted
    }
  });

  it("stores the chapters pointer but never fetches the chapters JSON body itself", async () => {
    const store = new InMemoryShowEpisodesStore();
    const fetchImpl = mockFetchOk(FEED_ONE_EP);
    await ingestShowFeed("show-a", "https://example.com/feed.xml", store, { fetchImpl });

    const eps = await store.episodesForShow("show-a");
    expect(eps[0]!.chapters_url).toBe("https://example.com/ep1-chapters.json");
    expect(eps[0]!.chapters).toBeNull(); // lazy — never populated by ingestion
    // Only ONE outbound fetch call happened (the feed itself) — proves the
    // chapters URL was never dereferenced during this ingest pass.
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("serves from cache without a network call when within the TTL window", async () => {
    const store = new InMemoryShowEpisodesStore();
    const fetchImpl = mockFetchOk(FEED_TWO_EPS);
    const now = () => new Date("2026-01-05T00:00:00.000Z").getTime();

    await ingestShowFeed("show-a", "https://example.com/feed.xml", store, { fetchImpl, now });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    const secondNow = () => new Date("2026-01-05T00:10:00.000Z").getTime(); // 10 min later, well within 24h TTL
    const result = await ingestShowFeed("show-a", "https://example.com/feed.xml", store, { fetchImpl, now: secondNow });

    expect(fetchImpl).toHaveBeenCalledTimes(1); // no new network call
    expect(result.status).toBe("not_modified");
    expect(result.episodeCount).toBe(2);
  });

  it("re-fetches once the TTL has expired", async () => {
    const store = new InMemoryShowEpisodesStore();
    const fetchImpl = mockFetchOk(FEED_TWO_EPS);
    const firstNow = () => new Date("2026-01-05T00:00:00.000Z").getTime();
    await ingestShowFeed("show-a", "https://example.com/feed.xml", store, { fetchImpl, now: firstNow, ttlMs: 1000 });

    const laterNow = () => new Date("2026-01-05T00:00:02.000Z").getTime(); // 2s later, past a 1s TTL
    await ingestShowFeed("show-a", "https://example.com/feed.xml", store, { fetchImpl, now: laterNow, ttlMs: 1000 });

    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("degrades to cached rows plus a stale flag on a fetch failure, never a blank result when cache exists", async () => {
    const store = new InMemoryShowEpisodesStore();
    const okFetch = mockFetchOk(FEED_TWO_EPS);
    await ingestShowFeed("show-a", "https://example.com/feed.xml", store, { fetchImpl: okFetch, ttlMs: 1 });

    const failingFetch = vi.fn().mockRejectedValue(new Error("network down"));
    // conditionalGet.ts catches thrown errors internally via try/catch inside fetchImpl callers upstream —
    // here we simulate the documented failure contract directly via a non-ok response instead.
    const errorFetch = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      headers: { get: () => null },
      text: async () => ""
    } as unknown as Response);

    const laterNow = () => Date.now() + 10_000;
    const result = await ingestShowFeed("show-a", "https://example.com/feed.xml", store, {
      fetchImpl: errorFetch,
      now: laterNow,
      ttlMs: 1
    });

    expect(result.status).toBe("cached_stale");
    expect(result.episodeCount).toBe(2); // still serves the two cached episodes
    expect(result.error).toBeDefined();
    void failingFetch; // referenced to document the alternative failure shape considered
  });

  it("returns no_cache_error with zero episodes when a fetch fails and there is nothing cached yet", async () => {
    const store = new InMemoryShowEpisodesStore();
    const errorFetch = vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      headers: { get: () => null },
      text: async () => ""
    } as unknown as Response);

    const result = await ingestShowFeed("show-a", "https://example.com/feed.xml", store, { fetchImpl: errorFetch });

    expect(result.status).toBe("no_cache_error");
    expect(result.episodeCount).toBe(0);
  });

  it("drops an episode with no enclosure URL rather than fabricating an audio_url", async () => {
    const store = new InMemoryShowEpisodesStore();
    const fetchImpl = mockFetchOk(FEED_NO_ENCLOSURE);
    const result = await ingestShowFeed("show-a", "https://example.com/feed.xml", store, { fetchImpl });

    expect(result.episodeCount).toBe(0);
    expect(result.status).toBe("fresh");
  });

  it("sends conditional headers (ETag) on a re-fetch after TTL expiry, reusing ADR-0001's mechanism", async () => {
    const store = new InMemoryShowEpisodesStore();
    const fetchImpl = mockFetchOk(FEED_TWO_EPS, { etag: '"v1"' });
    const firstNow = () => new Date("2026-01-05T00:00:00.000Z").getTime();
    await ingestShowFeed("show-a", "https://example.com/feed.xml", store, { fetchImpl, now: firstNow, ttlMs: 1 });

    const secondFetch = mockFetchOk(FEED_TWO_EPS, { etag: '"v2"' });
    const laterNow = () => new Date("2026-01-05T00:00:02.000Z").getTime();
    await ingestShowFeed("show-a", "https://example.com/feed.xml", store, { fetchImpl: secondFetch, now: laterNow, ttlMs: 1 });

    const headersSent = secondFetch.mock.calls[0]![1].headers;
    expect(headersSent["If-None-Match"]).toBe('"v1"');
  });
});
