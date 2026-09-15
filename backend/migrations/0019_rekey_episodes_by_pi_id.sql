-- 0019_rekey_episodes_by_pi_id.sql
-- S-09 (kanban t_f00c0a28). Rekeys 0016's `catalog_show_episodes` and
-- `catalog_show_feed_state` from `show_id` (data/catalog.json's curated
-- slug) to `pi_id` (shows_catalog's PodcastIndex id, 0017/0018) — the show
-- list moves from "220 curated slugs" to "every pi_id shows_catalog
-- carries", and episode/feed-state rows need to follow the same key so a
-- feed's polling history survives the swap. `show_id_map` (0018) is the
-- join: every existing row's `show_id` must resolve through it to a
-- `pi_id`, or it is orphaned data pointing at a curated slug this import
-- run's id-map did not carry (should not happen — S-04a fails the whole
-- build closed on any unmapped curated show — but this migration does not
-- assume that guarantee holds forever, see the orphan handling below).
--
-- ACCEPTANCE: rekey preserves a seeded 0016 row set (existing
-- catalog_show_episodes/catalog_show_feed_state rows keyed by show_id must
-- still exist, now keyed by pi_id, with all their other columns
-- untouched) — enforced by backend/test/shows-rekey.test.ts.

alter table catalog_show_episodes
  add column if not exists pi_id bigint;

alter table catalog_show_feed_state
  add column if not exists pi_id bigint;

update catalog_show_episodes e
set pi_id = m.pi_id
from show_id_map m
where m.show_id = e.show_id
  and e.pi_id is null;

update catalog_show_feed_state f
set pi_id = m.pi_id
from show_id_map m
where m.show_id = f.show_id
  and f.pi_id is null;

-- Orphans: a row whose show_id has no entry in show_id_map (the mapping
-- table is empty, or that curated slug was retired). Named loudly rather
-- than silently dropped or silently left half-migrated — the row keeps its
-- original show_id-keyed primary key and is EXCLUDED from the new pi_id
-- primary key below, so the migration itself never destroys data; the
-- application code (S-09's search/serving path) only reads pi_id-keyed
-- rows going forward, which is what "rekey" means for the shipped feature.
do $$
declare
  orphan_episode_count integer;
  orphan_feed_state_count integer;
begin
  select count(*) into orphan_episode_count from catalog_show_episodes where pi_id is null;
  select count(*) into orphan_feed_state_count from catalog_show_feed_state where pi_id is null;
  if orphan_episode_count > 0 then
    raise notice 'catalog_show_episodes: % row(s) have a show_id with no show_id_map entry and were NOT rekeyed (still keyed by show_id only)', orphan_episode_count;
  end if;
  if orphan_feed_state_count > 0 then
    raise notice 'catalog_show_feed_state: % row(s) have a show_id with no show_id_map entry and were NOT rekeyed (still keyed by show_id only)', orphan_feed_state_count;
  end if;
end $$;

-- Rename the old show_id-keyed columns to legacy_show_id (kept, not
-- dropped — PostgresShowEpisodesStore, the show-page read path shipped in
-- Stage 3b, still reads/writes by that key and is NOT rewired to pi_id by
-- this card; see backend/src/catalog/showEpisodesStore.ts, updated in this
-- same change to use legacy_show_id). 0016's original primary keys named
-- the old column directly, so drop those constraints, rename, then
-- RE-CREATE an equivalent unique constraint on the renamed column — the
-- store's `on conflict` clauses need a constraint to target, and nothing
-- about this card removes the show_id-keyed read path from production.
alter table catalog_show_episodes drop constraint if exists catalog_show_episodes_pkey;
alter table catalog_show_feed_state drop constraint if exists catalog_show_feed_state_pkey;

alter table catalog_show_episodes rename column show_id to legacy_show_id;
alter table catalog_show_feed_state rename column show_id to legacy_show_id;

alter table catalog_show_episodes alter column legacy_show_id drop not null;
alter table catalog_show_feed_state alter column legacy_show_id drop not null;

-- Equivalent to the dropped 0016 primary keys, just nullable (an orphan row
-- with no show_id_map entry keeps legacy_show_id but never gets a pi_id —
-- see the orphan handling above — so this cannot be NOT NULL anymore).
create unique index if not exists idx_cse_legacy_show_id_guid
  on catalog_show_episodes (legacy_show_id, guid)
  where legacy_show_id is not null;

create unique index if not exists idx_csfs_legacy_show_id
  on catalog_show_feed_state (legacy_show_id)
  where legacy_show_id is not null;

-- New primary keys, pi_id-based, only over rows that resolved (orphans have
-- pi_id null and cannot be part of a not-null primary key — they remain
-- queryable by legacy_show_id, just outside the new key space until
-- re-mapped).
create unique index if not exists idx_cse_pi_id_guid
  on catalog_show_episodes (pi_id, guid)
  where pi_id is not null;

create unique index if not exists idx_csfs_pi_id
  on catalog_show_feed_state (pi_id)
  where pi_id is not null;

drop index if exists idx_cse_show_published;
create index if not exists idx_cse_pi_id_published
  on catalog_show_episodes (pi_id, published_at desc);

alter table catalog_show_episodes
  add constraint fk_cse_pi_id foreign key (pi_id) references shows_catalog(pi_id) on delete set null;

alter table catalog_show_feed_state
  add constraint fk_csfs_pi_id foreign key (pi_id) references shows_catalog(pi_id) on delete set null;

-- Re-runnable backfill, not just this one-shot migration pass: when this
-- migration applies, show_id_map (0018) is freshly created and EMPTY (no
-- import has run yet), so the UPDATE above resolves nothing on a normal
-- first deploy — every existing row lands as an "orphan" the moment this
-- migration runs, which is correct for that instant but would stay wrong
-- forever if nothing ever re-ran the join. load-postgres.mjs's
-- `backfillLegacyShowIdKeys()` (tools/shows/load-postgres.mjs) re-runs this
-- exact UPDATE...FROM after every real import populates show_id_map, so a
-- row that was an orphan at migration time gets its pi_id filled in on the
-- very next import that maps its show_id — this migration's own pass is
-- the first attempt, not the only one.

