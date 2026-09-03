import { describe, it, expect, beforeEach } from "vitest";
import { InMemoryShowEpisodesStore, type CatalogShowEpisode } from "../src/catalog/showEpisodesStore";

function ep(overrides: Partial<CatalogShowEpisode> = {}): CatalogShowEpisode {
  return {
    show_id: "show-a",
    guid: "guid-1",
    title: "Episode 1",
    description_html: "<p>Hi</p>",
    description_text: "Hi",
    published_at: "2026-01-01T00:00:00.000Z",
    duration_seconds: 600,
    audio_url: "https://cdn.example.com/ep1.mp3",
    season_number: null,
    episode_number: null,
    chapters_url: null,
    chapters: null,
    ...overrides
  };
}

describe("InMemoryShowEpisodesStore", () => {
  let store: InMemoryShowEpisodesStore;
  beforeEach(() => {
    store = new InMemoryShowEpisodesStore();
  });

  it("returns an empty list for a show with no episodes", async () => {
    expect(await store.episodesForShow("nope")).toEqual([]);
  });

  it("upserts and retrieves episodes scoped to their show_id", async () => {
    await store.upsertEpisodes([ep({ show_id: "show-a", guid: "g1" }), ep({ show_id: "show-b", guid: "g2" })]);
    const a = await store.episodesForShow("show-a");
    expect(a).toHaveLength(1);
    expect(a[0]!.guid).toBe("g1");
  });

  it("orders episodes by published_at descending, nulls last", async () => {
    await store.upsertEpisodes([
      ep({ guid: "old", published_at: "2025-01-01T00:00:00.000Z" }),
      ep({ guid: "new", published_at: "2026-01-01T00:00:00.000Z" }),
      ep({ guid: "unknown", published_at: null })
    ]);
    const eps = await store.episodesForShow("show-a");
    expect(eps.map((e) => e.guid)).toEqual(["new", "old", "unknown"]);
  });

  it("upsert on the same (show_id, guid) replaces the row rather than duplicating it", async () => {
    await store.upsertEpisodes([ep({ guid: "g1", title: "First title" })]);
    await store.upsertEpisodes([ep({ guid: "g1", title: "Updated title" })]);
    const eps = await store.episodesForShow("show-a");
    expect(eps).toHaveLength(1);
    expect(eps[0]!.title).toBe("Updated title");
  });

  it("feed state round-trips through recordFeedFetch/getFeedState", async () => {
    expect(await store.getFeedState("show-a")).toBeNull();
    await store.recordFeedFetch({
      show_id: "show-a",
      feed_url: "https://example.com/feed.xml",
      etag: '"abc"',
      last_modified: null,
      last_fetched_at: "2026-01-01T00:00:00.000Z",
      last_fetch_ok: true,
      last_error: null,
      consecutive_failures: 0
    });
    const state = await store.getFeedState("show-a");
    expect(state?.etag).toBe('"abc"');
    expect(state?.last_fetch_ok).toBe(true);
  });
});
