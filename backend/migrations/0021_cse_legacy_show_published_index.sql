-- 0021_cse_legacy_show_published_index.sql
-- CH2-01 (docs/roadmap/code-health-2.md, B2-09). Restores the index the
-- show page's episode list reads through.
--
-- 0016 created idx_cse_show_published on (show_id, published_at desc).
-- 0019 renamed show_id to legacy_show_id, dropped that index and created
-- idx_cse_pi_id_published on (pi_id, ...) in its place, but
-- PostgresShowEpisodesStore still reads by legacy_show_id:
--
--   where legacy_show_id = $1 order by published_at desc nulls last
--
-- (backend/src/catalog/showEpisodesStore.ts episodesForShow). With only the
-- (legacy_show_id, guid) unique index left, every page request found the
-- show's rows and then sorted all of them (a 2,800-episode show, every page).
--
-- `nulls last` matches the store's ORDER BY exactly: a plain `desc` key is
-- DESC NULLS FIRST, which cannot hand that query its order, so it would
-- still sort. tools/shows/shows-postgres-integration.test.mjs EXPLAINs the
-- store's own query against this index (no Sort node).
--
-- 0020 is reserved for shows-search PKG-10; the migrate CLI applies files in
-- sorted order with no gap check, so 0021 ahead of it is safe.

create index if not exists idx_cse_legacy_show_published
  on catalog_show_episodes (legacy_show_id, published_at desc nulls last);
