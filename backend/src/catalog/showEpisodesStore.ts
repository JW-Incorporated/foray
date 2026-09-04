import type { Client } from "pg";

/**
 * Shared-catalogue per-show episode storage (Stage 3b, kanban t_567b570f,
 * docs/show-pages-plan.md §Stage 3 / backend/migrations/0016_catalog_show_episodes.sql).
 *
 * Deliberately NOT the `shows`/`episodes` tables (0002/0003) — those are
 * per-user tracked feeds. This is one shared catalogue every visitor reads
 * identically, keyed on `show_id` (catalog.json / catalog-breadth.json),
 * not `user_id`. Pluggable-sink pattern matching `curation/eventStore.ts`:
 * `InMemoryShowEpisodesStore` for tests, `PostgresShowEpisodesStore` for the
 * serverless endpoint (service-role connection).
 */

export interface ChapterMarker {
  title: string;
  start_time_seconds: number;
}

export interface CatalogShowEpisode {
  show_id: string;
  guid: string;
  title: string;
  description_html: string | null;
  description_text: string | null;
  published_at: string | null; // ISO 8601
  duration_seconds: number | null;
  audio_url: string;
  season_number: number | null;
  episode_number: number | null;
  chapters_url: string | null;
  chapters: ChapterMarker[] | null; // populated lazily — see backend/src/catalog/ingestShowFeed.ts
}

export interface ShowFeedState {
  show_id: string;
  feed_url: string;
  etag: string | null;
  last_modified: string | null;
  last_fetched_at: string | null;
  last_fetch_ok: boolean | null;
  last_error: string | null;
  consecutive_failures: number;
}

export interface ShowEpisodesStore {
  /** Episodes for a show, published-date descending — the show page's read path. */
  episodesForShow(showId: string): Promise<CatalogShowEpisode[]>;

  /** Upserts a full ingested batch for one show (identity: show_id + guid). */
  upsertEpisodes(episodes: CatalogShowEpisode[]): Promise<void>;

  getFeedState(showId: string): Promise<ShowFeedState | null>;

  /** Records a fetch attempt's outcome (success or failure) for cache-freshness decisions. */
  recordFeedFetch(state: ShowFeedState): Promise<void>;
}

export class InMemoryShowEpisodesStore implements ShowEpisodesStore {
  private readonly episodes = new Map<string, CatalogShowEpisode>(); // key: show_id\x00guid
  private readonly feedStates = new Map<string, ShowFeedState>();

  private key(showId: string, guid: string): string {
    return `${showId}\x00${guid}`;
  }

  async episodesForShow(showId: string): Promise<CatalogShowEpisode[]> {
    return [...this.episodes.values()]
      .filter((e) => e.show_id === showId)
      .sort((a, b) => {
        const at = a.published_at ? new Date(a.published_at).getTime() : -Infinity;
        const bt = b.published_at ? new Date(b.published_at).getTime() : -Infinity;
        return bt - at;
      });
  }

  async upsertEpisodes(episodes: CatalogShowEpisode[]): Promise<void> {
    for (const ep of episodes) {
      this.episodes.set(this.key(ep.show_id, ep.guid), ep);
    }
  }

  async getFeedState(showId: string): Promise<ShowFeedState | null> {
    return this.feedStates.get(showId) ?? null;
  }

  async recordFeedFetch(state: ShowFeedState): Promise<void> {
    this.feedStates.set(state.show_id, state);
  }

  reset(): void {
    this.episodes.clear();
    this.feedStates.clear();
  }
}

export class PostgresShowEpisodesStore implements ShowEpisodesStore {
  constructor(private readonly client: Client) {}

  async episodesForShow(showId: string): Promise<CatalogShowEpisode[]> {
    const result = await this.client.query(
      `select show_id, guid, title, description_html, description_text, published_at,
              duration_seconds, audio_url, season_number, episode_number, chapters_url, chapters
       from catalog_show_episodes
       where show_id = $1
       order by published_at desc nulls last`,
      [showId]
    );
    return result.rows.map(rowToEpisode);
  }

  async upsertEpisodes(episodes: CatalogShowEpisode[]): Promise<void> {
    if (episodes.length === 0) return;
    for (const ep of episodes) {
      await this.client.query(
        `insert into catalog_show_episodes
           (show_id, guid, title, description_html, description_text, published_at,
            duration_seconds, audio_url, season_number, episode_number, chapters_url, chapters, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         on conflict (show_id, guid) do update set
           title = excluded.title,
           description_html = excluded.description_html,
           description_text = excluded.description_text,
           published_at = excluded.published_at,
           duration_seconds = excluded.duration_seconds,
           audio_url = excluded.audio_url,
           season_number = excluded.season_number,
           episode_number = excluded.episode_number,
           chapters_url = excluded.chapters_url,
           -- never overwrite a lazily-fetched chapters body with null on a re-ingest
           chapters = coalesce(excluded.chapters, catalog_show_episodes.chapters),
           updated_at = now()`,
        [
          ep.show_id,
          ep.guid,
          ep.title,
          ep.description_html,
          ep.description_text,
          ep.published_at,
          ep.duration_seconds,
          ep.audio_url,
          ep.season_number,
          ep.episode_number,
          ep.chapters_url,
          ep.chapters ? JSON.stringify(ep.chapters) : null
        ]
      );
    }
  }

  async getFeedState(showId: string): Promise<ShowFeedState | null> {
    const result = await this.client.query(
      `select show_id, feed_url, etag, last_modified, last_fetched_at, last_fetch_ok,
              last_error, consecutive_failures
       from catalog_show_feed_state
       where show_id = $1`,
      [showId]
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      show_id: row.show_id,
      feed_url: row.feed_url,
      etag: row.etag,
      last_modified: row.last_modified,
      last_fetched_at: row.last_fetched_at ? new Date(row.last_fetched_at).toISOString() : null,
      last_fetch_ok: row.last_fetch_ok,
      last_error: row.last_error,
      consecutive_failures: row.consecutive_failures
    };
  }

  async recordFeedFetch(state: ShowFeedState): Promise<void> {
    await this.client.query(
      `insert into catalog_show_feed_state
         (show_id, feed_url, etag, last_modified, last_fetched_at, last_fetch_ok, last_error, consecutive_failures, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now())
       on conflict (show_id) do update set
         feed_url = excluded.feed_url,
         etag = excluded.etag,
         last_modified = excluded.last_modified,
         last_fetched_at = excluded.last_fetched_at,
         last_fetch_ok = excluded.last_fetch_ok,
         last_error = excluded.last_error,
         consecutive_failures = excluded.consecutive_failures,
         updated_at = now()`,
      [
        state.show_id,
        state.feed_url,
        state.etag,
        state.last_modified,
        state.last_fetched_at,
        state.last_fetch_ok,
        state.last_error,
        state.consecutive_failures
      ]
    );
  }
}

function rowToEpisode(row: Record<string, unknown>): CatalogShowEpisode {
  return {
    show_id: row.show_id as string,
    guid: row.guid as string,
    title: row.title as string,
    description_html: row.description_html as string | null,
    description_text: row.description_text as string | null,
    published_at: row.published_at ? new Date(row.published_at as string).toISOString() : null,
    duration_seconds: row.duration_seconds as number | null,
    audio_url: row.audio_url as string,
    season_number: row.season_number as number | null,
    episode_number: row.episode_number as number | null,
    chapters_url: row.chapters_url as string | null,
    chapters: (row.chapters as ChapterMarker[] | null) ?? null
  };
}
