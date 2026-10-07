import { describe, it, expect, beforeEach } from "vitest";
import type { Client } from "pg";
import { InMemoryShowEpisodesStore, PostgresShowEpisodesStore, buildEpisodeUpsert, type CatalogShowEpisode } from "../src/catalog/showEpisodesStore";

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

/* Round-3 audit, lane L6 (backend-rest-9): the Postgres upsert is one batched
   statement per chunk inside BEGIN/COMMIT, and a failure rolls back. */
describe("PostgresShowEpisodesStore.upsertEpisodes", () => {
  function fakeClient(failOn?: RegExp) {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (failOn && failOn.test(sql)) throw new Error("invalid byte sequence");
        return { rows: [] };
      }
    };
    return { client: client as unknown as Client, calls };
  }
  const verbs = (calls: Array<{ sql: string }>) => calls.map((c) => c.sql.trim().split(/\s+/)[0]);

  it("upserts a whole show in one statement inside a transaction", async () => {
    const { client, calls } = fakeClient();
    const store = new PostgresShowEpisodesStore(client);
    await store.upsertEpisodes([ep({ guid: "g1" }), ep({ guid: "g2" }), ep({ guid: "g3" })]);
    expect(verbs(calls)).toEqual(["begin", "insert", "commit"]);
    expect(calls[1]!.params).toHaveLength(36);
  });

  it("rolls back and rethrows when the insert fails, so no half-ingested show is committed", async () => {
    const { client, calls } = fakeClient(/^\s*insert/);
    const store = new PostgresShowEpisodesStore(client);
    await expect(store.upsertEpisodes([ep({ guid: "g1" }), ep({ guid: "g2" })])).rejects.toThrow(/invalid byte/);
    expect(verbs(calls)).toEqual(["begin", "insert", "rollback"]);
  });

  it("de-duplicates by guid (last wins) so ON CONFLICT never touches a row twice", async () => {
    const { client, calls } = fakeClient();
    const store = new PostgresShowEpisodesStore(client);
    await store.upsertEpisodes([ep({ guid: "g1", title: "old" }), ep({ guid: "g1", title: "new" })]);
    const insert = calls[1]!;
    expect(insert.params).toHaveLength(12);
    expect(insert.params![2]).toBe("new");
  });

  it("buildEpisodeUpsert numbers placeholders per row", () => {
    const { sql, params } = buildEpisodeUpsert([ep({ guid: "a" }), ep({ guid: "b" })]);
    expect(sql).toContain("$13");
    expect(sql).toContain("$24");
    expect(sql).not.toContain("$25");
    expect(params[13]).toBe("b");
  });
});

/* PKG-02 (S-09): migration 0019 renames catalog_show_episodes /
   catalog_show_feed_state's `show_id` to `legacy_show_id` and recreates the
   unique indexes on the renamed column. Every statement this store sends
   must name the new column, or each read errors with "column show_id does
   not exist" and each upsert fails with "no unique or exclusion constraint
   matching the ON CONFLICT specification" once 0019 is applied. Reads alias
   it back to `show_id` so the public CatalogShowEpisode/ShowFeedState shape
   does not change. */
describe("PostgresShowEpisodesStore after the 0019 rekey (legacy_show_id)", () => {
  function recordingClient(rows: Record<string, unknown>[] = []) {
    const sqls: string[] = [];
    const client = {
      query: async (sql: string) => {
        sqls.push(sql);
        return { rows };
      }
    };
    return { client: client as unknown as Client, sqls };
  }
  const squash = (sql: string) => sql.replace(/\s+/g, " ");

  it("the batched episode upsert inserts into legacy_show_id and conflicts on (legacy_show_id, guid)", () => {
    const sql = squash(buildEpisodeUpsert([ep()]).sql);
    expect(sql).toContain("insert into catalog_show_episodes (legacy_show_id, guid, title,");
    expect(sql).toContain("on conflict (legacy_show_id, guid) do update set");
    expect(sql).not.toMatch(/[(,]\s*show_id\b/);
  });

  it("episode and feed-state reads filter on legacy_show_id and alias it back to show_id; the feed-state upsert conflicts on legacy_show_id", async () => {
    const { client, sqls } = recordingClient([{ show_id: "show-a", guid: "g1", title: "t", feed_url: "u", last_fetched_at: null }]);
    const store = new PostgresShowEpisodesStore(client);
    const eps = await store.episodesForShow("show-a");
    const state = await store.getFeedState("show-a");
    await store.recordFeedFetch({
      show_id: "show-a",
      feed_url: "https://example.com/feed.xml",
      etag: null,
      last_modified: null,
      last_fetched_at: null,
      last_fetch_ok: true,
      last_error: null,
      consecutive_failures: 0
    });
    const [readEpisodes, readState, writeState] = sqls.map(squash);
    expect(readEpisodes).toMatch(/^select legacy_show_id as show_id, guid,/);
    expect(readEpisodes).toContain("where legacy_show_id = $1");
    expect(readState).toMatch(/^select legacy_show_id as show_id, feed_url,/);
    expect(readState).toContain("where legacy_show_id = $1");
    expect(writeState).toContain("insert into catalog_show_feed_state (legacy_show_id, feed_url,");
    expect(writeState).toContain("on conflict (legacy_show_id) do update set");
    expect(eps[0]!.show_id).toBe("show-a");
    expect(state?.show_id).toBe("show-a");
  });
});

/* CH2-01 (B2-01): what a re-ingest does to a row's chapters. Ingest now writes
   the feed's inline psc:chapters, so a feed that later drops its chapters block
   must clear them in BOTH stores; the Postgres upsert used to coalesce the old
   value back in (a "lazy fetch" that never existed). */
describe("chapters on a re-upsert (CH2-01)", () => {
  const squash = (sql: string) => sql.replace(/\s+/g, " ");
  const marker = [{ title: "Intro", start_time_seconds: 0 }];

  it("PIN (main today): the Postgres upsert coalesces chapters, keeping the old ones when the new row has none", () => {
    // MUTATION: change the upsert to `chapters = excluded.chapters` -> red (this pin flips in the fix commit).
    const sql = squash(buildEpisodeUpsert([ep()]).sql);
    expect(sql).toContain("chapters = coalesce(excluded.chapters, catalog_show_episodes.chapters)");
  });

  it("InMemory: a re-upsert whose row has no chapters clears the stored ones", async () => {
    // MUTATION: InMemory upsertEpisodes keeps `chapters: ep.chapters ?? existing.chapters` -> red.
    const store = new InMemoryShowEpisodesStore();
    await store.upsertEpisodes([ep({ guid: "g1", chapters: marker })]);
    expect((await store.episodesForShow("show-a"))[0]!.chapters).toEqual(marker);
    await store.upsertEpisodes([ep({ guid: "g1", chapters: null })]);
    expect((await store.episodesForShow("show-a"))[0]!.chapters).toBeNull();
  });
});
