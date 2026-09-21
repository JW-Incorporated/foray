-- 0017_shows_catalog.sql
-- S-09 (kanban t_f00c0a28, source: 4a-shows-pipeline-plan.md §3.3). Postgres
-- mirror of the static shard index S-04a already builds
-- (tools/shows/shard-build.mjs's manifest/shards/top/id-map/changed shapes),
-- so the backend can serve FTS+trgm show search without shipping every
-- PodcastIndex row to the client. `pi_id` = the PodcastIndex dump's
-- `podcasts.id`, the same integer `import-dump.mjs`'s canonical rows and
-- `id-map.json` already key on (see tools/shows/shard-build.mjs's
-- buildIdMap). This table is the canonical (post D1-filter, post-D13-dedupe)
-- row set for ONE import run; `tools/shows/load-postgres.mjs` (S-09) is the
-- only writer, upserting from `import-dump.mjs`'s in-memory result (COPY
-- into a staging table, then upsert — see that file's header).
--
-- Deliberately separate from `catalog_show_episodes`/`catalog_show_feed_state`
-- (0016) and from `shows`/`episodes` (0002/0003): those are episode-level and
-- either per-user or per-curated-show; this is show-level breadth data for
-- ~10k+ shows, existing purely to answer "which shows are there" search
-- queries. `catalog_show_episodes.show_id` is rekeyed to this table's `pi_id`
-- in 0019 once this table exists.

create table if not exists shows_catalog (
  pi_id               bigint primary key,        -- PodcastIndex podcasts.id (dump-stable)
  title               text not null,
  author              text,                       -- itunesAuthor, falling back to itunesOwnerName (shard-build.mjs's `a` field)
  itunes_id           bigint,                      -- Apple collection id, when present
  feed_url            text not null,
  image_url           text,
  episode_count       integer,
  popularity_score    double precision,
  explicit            boolean,
  language            text,                        -- stored, never filtered (D1's language column is explicitly open — see tools/shows/filter.mjs)
  dead                boolean not null default false,
  newest_item_at      timestamptz,                 -- from newestItemPubdate; drives changed.json / D1 staleness
  curated             boolean not null default false, -- true for the 220 in data/catalog.json (S-04a's curated exemption)
  category1           text,
  category2           text,
  category3           text,

  export_version      text not null,               -- the dump's Last-Modified header this row last came from (import-dump.mjs's exportVersion)

  -- Generated tsvector: title weighted A, author weighted B — same two
  -- fields shard-build.mjs indexes into token-prefix shards client-side;
  -- this is the server-side equivalent for a real ranked search.
  search_tsv          tsvector generated always as (
                        setweight(to_tsvector('english', coalesce(title, '')), 'A') ||
                        setweight(to_tsvector('english', coalesce(author, '')), 'B')
                      ) stored,

  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists idx_shows_catalog_search_tsv
  on shows_catalog using gin (search_tsv);

-- Fuzzy/typo-tolerant title matching (search-shows.mjs's trgm ranking path).
-- Requires pg_trgm (0001_extensions.sql already creates it as `create
-- extension if not exists`; re-asserted here defensively in case this
-- migration is ever applied against an older base that skipped 0001).
create extension if not exists pg_trgm;

create index if not exists idx_shows_catalog_title_trgm
  on shows_catalog using gin (title gin_trgm_ops);

create index if not exists idx_shows_catalog_popularity
  on shows_catalog (popularity_score desc);

create index if not exists idx_shows_catalog_curated
  on shows_catalog (curated) where curated;
