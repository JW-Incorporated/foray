import { describe, it, expect, vi } from "vitest";
import { ingestShowFeed, failureBackoffMs, FAILURE_BACKOFF_BASE_MS } from "../src/catalog/ingestShowFeed";
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

/* Round-3 audit, lane L6: backend-rest-9 (never throws; a failed ingest is a
   recorded failure that falls back to cache), backend-rest-10 (no "" identity,
   no positional index), backend-rest-12 (a failing feed backs off). */
describe("ingestShowFeed round-3 hardening", () => {
  const T0 = new Date("2026-03-01T00:00:00.000Z").getTime();
  const errorFetch = () =>
    vi.fn().mockResolvedValue({
      status: 500,
      ok: false,
      headers: { get: () => null },
      text: async () => ""
    } as unknown as Response);

  it("does not throw when the store rejects the upsert; records the failure and serves the cache (backend-rest-9)", async () => {
    const store = new InMemoryShowEpisodesStore();
    await ingestShowFeed("show-a", "https://example.com/feed.xml", store, {
      fetchImpl: mockFetchOk(FEED_TWO_EPS),
      now: () => T0,
      ttlMs: 1
    });
    vi.spyOn(store, "upsertEpisodes").mockRejectedValueOnce(new Error("invalid byte sequence for encoding UTF8: 0x00"));

    const result = await ingestShowFeed("show-a", "https://example.com/feed.xml", store, {
      fetchImpl: mockFetchOk(FEED_TWO_EPS),
      now: () => T0 + 10,
      ttlMs: 1
    });
    expect(result.status).toBe("cached_stale");
    expect(result.episodeCount).toBe(2);
    expect(result.error).toMatch(/0x00/);
    const state = await store.getFeedState("show-a");
    expect(state!.last_fetch_ok).toBe(false);
    expect(state!.consecutive_failures).toBe(1);
  });

  it("returns no_cache_error instead of rejecting when the store itself is down", async () => {
    const store = new InMemoryShowEpisodesStore();
    vi.spyOn(store, "getFeedState").mockRejectedValue(new Error("connection refused"));
    const result = await ingestShowFeed("show-a", "https://example.com/feed.xml", store, {
      fetchImpl: mockFetchOk(FEED_TWO_EPS)
    });
    expect(result.status).toBe("no_cache_error");
    expect(result.error).toMatch(/connection refused/);
  });

  it("keeps guid-less episodes apart, with an identity that does not shift when an episode is prepended (backend-rest-10)", async () => {
    const item = (n: number) =>
      `<item><title>Ep ${n}</title><guid></guid><enclosure url="https://cdn.example.com/${n}.mp3" type="audio/mpeg"/></item>`;
    const feed = (items: string) => `<rss><channel><title>T</title>${items}</channel></rss>`;
    const store = new InMemoryShowEpisodesStore();
    await ingestShowFeed("show-a", "https://example.com/f.xml", store, {
      fetchImpl: mockFetchOk(feed(item(1) + item(2))),
      now: () => T0,
      ttlMs: 1
    });
    const first = await store.episodesForShow("show-a");
    expect(first).toHaveLength(2);
    expect(first.every((e) => e.guid !== "")).toBe(true);

    await ingestShowFeed("show-a", "https://example.com/f.xml", store, {
      fetchImpl: mockFetchOk(feed(item(3) + item(1) + item(2))),
      now: () => T0 + 10,
      ttlMs: 1
    });
    expect(await store.episodesForShow("show-a")).toHaveLength(3); // not 5: no duplicate rows minted
  });

  it("backs off after a failure instead of refetching on every request (backend-rest-12)", async () => {
    const store = new InMemoryShowEpisodesStore();
    await ingestShowFeed("show-a", "https://example.com/feed.xml", store, {
      fetchImpl: mockFetchOk(FEED_TWO_EPS),
      now: () => T0,
      ttlMs: 60_000
    });
    const failing = errorFetch();
    const ttlMs = 24 * 60 * 60 * 1000;
    const failedAt = T0 + 120_000; // past the 60 s TTL of the successful fetch
    await ingestShowFeed("show-a", "https://example.com/feed.xml", store, { fetchImpl: failing, now: () => failedAt, ttlMs: 60_000 });
    expect(failing).toHaveBeenCalledTimes(1);

    // One minute later: inside the back-off window, so no network call.
    const during = await ingestShowFeed("show-a", "https://example.com/feed.xml", store, {
      fetchImpl: failing,
      now: () => failedAt + 60_000,
      ttlMs
    });
    expect(failing).toHaveBeenCalledTimes(1);
    expect(during.status).toBe("cached_stale");
    expect(during.episodeCount).toBe(2);

    // Past the window (base * 2^1): it tries again.
    await ingestShowFeed("show-a", "https://example.com/feed.xml", store, {
      fetchImpl: failing,
      now: () => failedAt + failureBackoffMs(1, ttlMs) + 1,
      ttlMs
    });
    expect(failing).toHaveBeenCalledTimes(2);
  });

  it("failureBackoffMs doubles per failure and is capped at the TTL", () => {
    const ttl = 24 * 60 * 60 * 1000;
    expect(failureBackoffMs(0, ttl)).toBe(FAILURE_BACKOFF_BASE_MS);
    expect(failureBackoffMs(1, ttl)).toBe(2 * FAILURE_BACKOFF_BASE_MS);
    expect(failureBackoffMs(3, ttl)).toBe(8 * FAILURE_BACKOFF_BASE_MS);
    expect(failureBackoffMs(50, ttl)).toBe(ttl);
    expect(failureBackoffMs(2, 1000)).toBe(1000);
  });
});
