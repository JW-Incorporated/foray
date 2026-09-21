-- 0018_show_id_map.sql
-- S-09 (kanban t_f00c0a28). Durable, Postgres-side twin of S-04a's
-- `id-map.json` (tools/shows/shard-build.mjs's buildIdMap): which curated
-- show (data/catalog.json's `show_id` slug) resolves to which
-- `shows_catalog.pi_id`. Kept as its own table (not a column on
-- shows_catalog) because the relationship is really slug -> pi_id, and a
-- future curated show could in principle remap to a different pi_id across
-- dump releases (a feed migrating providers) without shows_catalog's own
-- primary key changing meaning.

create table if not exists show_id_map (
  show_id             text primary key,           -- data/catalog.json's show_id slug
  pi_id               bigint not null references shows_catalog(pi_id) on delete restrict,
  mapped_at           timestamptz not null default now(),
  export_version      text not null                -- which import run produced this mapping
);

create index if not exists idx_show_id_map_pi_id on show_id_map (pi_id);
