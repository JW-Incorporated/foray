-- 0016_catalog_show_episodes.sql
-- Stage 3b (docs/show-pages-plan.md §Stage 3, kanban t_567b570f): full
-- per-show RSS ingestion. This is deliberately NOT the `shows`/`episodes`
-- pair from 0002/0003 — those are per-user tracked feeds
-- (`unique(user_id, feed_url)`), the wrong shape for one shared catalogue
-- of ~10k shows every visitor reads identically. These two tables are
-- shared, service-role-owned public catalogue data (no RLS — nothing
-- personal lives here), joined against `data/catalog.json` /
-- `data/catalog-breadth.json`'s `show_id` (see docs/CATALOG-PIPELINE.md).

create table if not exists catalog_show_episodes (
  show_id             text not null,      -- catalog.json / catalog-breadth.json show_id
  guid                text not null,      -- RSS item guid; unreliable alone (ADR-0002) but the
                                           -- best available per-feed key at this shared-catalogue scale
  title               text not null,
  description_html    text,
  description_text    text,               -- sanitized; the real RSS field, replacing the curated `hook` fallback
  published_at        timestamptz,
  duration_seconds    integer,
  audio_url           text not null,      -- original enclosure URL, never rehosted (ADR-0007 / product principle #3)
  season_number       integer,
  episode_number       integer,
  chapters_url          text,             -- <podcast:chapters url> pointer only; body fetched lazily per-episode
  chapters               jsonb,           -- populated only once a listener opens the episode page (lazy fetch)

  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now(),

  primary key (show_id, guid)
);

create index if not exists idx_cse_show_published
  on catalog_show_episodes (show_id, published_at desc);

-- One row per show: cache/poll bookkeeping for the fetch-on-demand endpoint.
-- Mirrors ADR-0001's conditional-GET + per-host politeness discipline, but
-- keyed on show_id (not user) since this is the shared catalogue tier.
create table if not exists catalog_show_feed_state (
  show_id               text primary key,
  feed_url              text not null,
  etag                  text,
  last_modified         text,
  last_fetched_at       timestamptz,
  last_fetch_ok         boolean,
  last_error            text,
  consecutive_failures  integer not null default 0,

  updated_at            timestamptz not null default now()
);
