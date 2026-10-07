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
  /* The feed's INLINE chapters (psc:chapters), written by every ingest and
     overwritten by the next one (ingestShowFeed.ts toCatalogEpisode); null
     when the item has none. Nothing fetches chapters "lazily": 0016's column
     comment ("populated only once a listener opens the episode page (lazy
     fetch)") describes a path that was never built; 0016 is applied, so the
     correction lives here (CH2-01). */
  chapters: ChapterMarker[] | null;
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

  /** Whether any episode is stored for the show: the "is there a cache to
   *  fall back to" question ingest asks on a failure, without reading the list. */
  hasEpisodes(showId: string): Promise<boolean>;

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

  async hasEpisodes(showId: string): Promise<boolean> {
    for (const e of this.episodes.values()) if (e.show_id === showId) return true;
    return false;
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

  // NOTE (S-09, kanban t_f00c0a28): 0019_rekey_episodes_by_pi_id.sql renamed
  // catalog_show_episodes/catalog_show_feed_state's `show_id` column to
  // `legacy_show_id` (kept, not dropped) and re-created an equivalent
  // unique constraint on it so this store's existing show_id-keyed read
  // path keeps working unchanged after that migration — this class is
  // NOT rewired to pi_id by S-09; that is a future card's job once the
  // show-page feature itself moves off curated show_id slugs.
  //
  // Two corrections to the applied 0019, which must not be edited (CH2-01,
  // B2-09): its ACCEPTANCE line names backend/test/shows-rekey.test.ts,
  // which does not exist; the rekey acceptance test is
  // tools/shows/shows-postgres-integration.test.mjs ("rekey (0019)
  // preserves a seeded 0016 row set", line 129). And 0019 dropped 0016's
  // idx_cse_show_published, the only index serving episodesForShow's
  // `where legacy_show_id = $1 order by published_at desc nulls last`;
  // 0021_cse_legacy_show_published_index.sql restores it on the renamed
  // column (the same integration suite EXPLAINs this query against it).

  async episodesForShow(showId: string): Promise<CatalogShowEpisode[]> {
    const result = await this.client.query(
      `select legacy_show_id as show_id, guid, title, description_html, description_text, published_at,
              duration_seconds, audio_url, season_number, episode_number, chapters_url, chapters
       from catalog_show_episodes
       where legacy_show_id = $1
       order by published_at desc nulls last`,
      [showId]
    );
    return result.rows.map(rowToEpisode);
  }

  async hasEpisodes(showId: string): Promise<boolean> {
    const result = await this.client.query(
      `select 1 from catalog_show_episodes where legacy_show_id = $1 limit 1`,
      [showId]
    );
    return result.rows.length > 0;
  }

  /**
   * One multi-row INSERT ... ON CONFLICT per chunk, all inside one
   * transaction (backend-rest-9): a failing row now rolls the whole batch
   * back instead of leaving half a show upserted, and a 400-episode show
   * costs a handful of round trips rather than 400. Rows are de-duplicated
   * by guid first (last one wins, as the old per-row loop did), because
   * Postgres refuses an ON CONFLICT DO UPDATE that touches one row twice.
   */
  async upsertEpisodes(episodes: CatalogShowEpisode[]): Promise<void> {
    if (episodes.length === 0) return;
    const unique = [...new Map(episodes.map((ep) => [`${ep.show_id}\x00${ep.guid}`, ep])).values()];
    await this.client.query("begin");
    try {
      for (let i = 0; i < unique.length; i += UPSERT_CHUNK_ROWS) {
        const chunk = unique.slice(i, i + UPSERT_CHUNK_ROWS);
        const { sql, params } = buildEpisodeUpsert(chunk);
        await this.client.query(sql, params);
      }
      await this.client.query("commit");
    } catch (err) {
      await this.client.query("rollback").catch(() => undefined);
      throw err;
    }
  }

  async getFeedState(showId: string): Promise<ShowFeedState | null> {
    const result = await this.client.query(
      `select legacy_show_id as show_id, feed_url, etag, last_modified, last_fetched_at, last_fetch_ok,
              last_error, consecutive_failures
       from catalog_show_feed_state
       where legacy_show_id = $1`,
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
         (legacy_show_id, feed_url, etag, last_modified, last_fetched_at, last_fetch_ok, last_error, consecutive_failures, updated_at)
       values ($1,$2,$3,$4,$5,$6,$7,$8, now())
       on conflict (legacy_show_id) do update set
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

/** 12 params per row: 500 rows stays well under Postgres's 65535-parameter cap. */
const UPSERT_CHUNK_ROWS = 500;
const EPISODE_UPSERT_COLUMNS = 12;

/** Builds the batched upsert for one chunk. Exported for tests. */
export function buildEpisodeUpsert(episodes: CatalogShowEpisode[]): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const tuples = episodes.map((ep, row) => {
    params.push(
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
    );
    const base = row * EPISODE_UPSERT_COLUMNS;
    const slots = Array.from({ length: EPISODE_UPSERT_COLUMNS }, (_, c) => "$" + String(base + c + 1));
    return `(${slots.join(",")}, now())`;
  });
  const sql = `insert into catalog_show_episodes
       (legacy_show_id, guid, title, description_html, description_text, published_at,
        duration_seconds, audio_url, season_number, episode_number, chapters_url, chapters, updated_at)
     values ${tuples.join(", ")}
     on conflict (legacy_show_id, guid) do update set
       title = excluded.title,
       description_html = excluded.description_html,
       description_text = excluded.description_text,
       published_at = excluded.published_at,
       duration_seconds = excluded.duration_seconds,
       audio_url = excluded.audio_url,
       season_number = excluded.season_number,
       episode_number = excluded.episode_number,
       chapters_url = excluded.chapters_url,
       -- overwritten, never coalesced: a feed that drops its psc:chapters clears them, as InMemory does (CH2-01)
       chapters = excluded.chapters,
       updated_at = now()`;
  return { sql, params };
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
