-- supabase/0003_rls_least_privilege.sql  (Supabase project only — see README)
-- Round-3 code audit, lane L6 (backend-rest-4, backend-rest-5,
-- data-integrity-10). Builds on 0001 and 0002; apply after them, in filename
-- order. Idempotent: safe to re-run.
--
-- NOT APPLIED TO PRODUCTION BY THIS CHANGE. Applying it to the live Supabase
-- project is founder question Q3 (docs/audit/round-3-code/synthesis.md).
--
-- The rule: least privilege per table. A client (the publishable key, with or
-- without an anonymous session) gets exactly the verbs the shipped client uses
-- on that table, and no more. test/supabase-rls-verbs.test.js pins every
-- policy below against the PostgREST calls app.js actually makes, because a
-- verb missed here breaks "Delete my data" silently (a DELETE that RLS filters
-- to zero rows still answers 204).
--
-- The service role (the endpoint's pg connection, the learning job, migrate)
-- bypasses RLS, so nothing on the server side changes.

-- 1. The shared catalogue (0016): public READ, never public WRITE
--    (backend-rest-4). 0016 and DECISIONS.md said "no RLS" meaning "nothing
--    personal"; without RLS the anon key could upsert episodes (attacker
--    audio_url) and fake a feed's freshness.
alter table public.catalog_show_episodes enable row level security;
drop policy if exists public_read_catalog_show_episodes on public.catalog_show_episodes;
create policy public_read_catalog_show_episodes on public.catalog_show_episodes for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.catalog_show_episodes from anon, authenticated;

alter table public.catalog_show_feed_state enable row level security;
drop policy if exists public_read_catalog_show_feed_state on public.catalog_show_feed_state;
create policy public_read_catalog_show_feed_state on public.catalog_show_feed_state for select to anon, authenticated using (true);
revoke insert, update, delete, truncate on public.catalog_show_feed_state from anon, authenticated;

-- 2. Pipeline tables (0002/0003/0004/0010): service-role only. Deny-all RLS
--    (no policy) plus no write grants. Their user_id is the offline
--    pipeline's operator id, never a listener's auth.uid(): no client path
--    reads or writes them.
alter table public.shows enable row level security;
revoke insert, update, delete, truncate on public.shows from anon, authenticated;
alter table public.episodes enable row level security;
revoke insert, update, delete, truncate on public.episodes from anon, authenticated;
alter table public.episode_enrichment enable row level security;
revoke insert, update, delete, truncate on public.episode_enrichment from anon, authenticated;
alter table public.cost_events enable row level security;
revoke insert, update, delete, truncate on public.cost_events from anon, authenticated;

-- 3. Per-user tables: the `for all` own_rows_* policies from 0001/0002 are
--    split into one policy per verb (backend-rest-5).
--      events          select + insert + delete  (the client POSTs events;
--                                                 Delete my data DELETEs them)
--      user_interests  select + delete           (append-only audit log; the
--                                                 service-role job is the only
--                                                 writer)
--      taxonomy_nodes  select + delete           (no client weight writes:
--                                                 principle #2, observed never
--                                                 declared)
--      saved_items, sessions, session_items, subscriptions, app_users
--                      select + delete           (the client only deletes them)
--      learning_cursor select + delete           (data-integrity-10: was
--                                                 deny-all, so Delete my data
--                                                 could not reach it)
--    SELECT stays on every table because a filtered DELETE
--    (`?user_id=eq.<uid>`) reads the rows it matches, so Postgres applies the
--    SELECT policy to it too. UPDATE is granted nowhere. Written out table by
--    table (no loop) so a reviewer, and the verb-pin test, read exactly what
--    each table allows.

-- events
alter table public.events enable row level security;
drop policy if exists own_rows_events on public.events;
drop policy if exists own_select_events on public.events;
drop policy if exists own_insert_events on public.events;
drop policy if exists own_update_events on public.events;
drop policy if exists own_delete_events on public.events;
create policy own_select_events on public.events for select to authenticated using ((select auth.uid()) = user_id);
create policy own_insert_events on public.events for insert to authenticated with check ((select auth.uid()) = user_id);
create policy own_delete_events on public.events for delete to authenticated using ((select auth.uid()) = user_id);
revoke update, truncate on public.events from anon, authenticated;

-- saved_items
alter table public.saved_items enable row level security;
drop policy if exists own_rows_saved_items on public.saved_items;
drop policy if exists own_select_saved_items on public.saved_items;
drop policy if exists own_insert_saved_items on public.saved_items;
drop policy if exists own_update_saved_items on public.saved_items;
drop policy if exists own_delete_saved_items on public.saved_items;
create policy own_select_saved_items on public.saved_items for select to authenticated using ((select auth.uid()) = user_id);
create policy own_delete_saved_items on public.saved_items for delete to authenticated using ((select auth.uid()) = user_id);
revoke update, truncate on public.saved_items from anon, authenticated;

-- user_interests
alter table public.user_interests enable row level security;
drop policy if exists own_rows_user_interests on public.user_interests;
drop policy if exists own_select_user_interests on public.user_interests;
drop policy if exists own_insert_user_interests on public.user_interests;
drop policy if exists own_update_user_interests on public.user_interests;
drop policy if exists own_delete_user_interests on public.user_interests;
create policy own_select_user_interests on public.user_interests for select to authenticated using ((select auth.uid()) = user_id);
create policy own_delete_user_interests on public.user_interests for delete to authenticated using ((select auth.uid()) = user_id);
revoke update, truncate on public.user_interests from anon, authenticated;

-- sessions
alter table public.sessions enable row level security;
drop policy if exists own_rows_sessions on public.sessions;
drop policy if exists own_select_sessions on public.sessions;
drop policy if exists own_insert_sessions on public.sessions;
drop policy if exists own_update_sessions on public.sessions;
drop policy if exists own_delete_sessions on public.sessions;
create policy own_select_sessions on public.sessions for select to authenticated using ((select auth.uid()) = user_id);
create policy own_delete_sessions on public.sessions for delete to authenticated using ((select auth.uid()) = user_id);
revoke update, truncate on public.sessions from anon, authenticated;

-- session_items
alter table public.session_items enable row level security;
drop policy if exists own_rows_session_items on public.session_items;
drop policy if exists own_select_session_items on public.session_items;
drop policy if exists own_insert_session_items on public.session_items;
drop policy if exists own_update_session_items on public.session_items;
drop policy if exists own_delete_session_items on public.session_items;
create policy own_select_session_items on public.session_items for select to authenticated using ((select auth.uid()) = user_id);
create policy own_delete_session_items on public.session_items for delete to authenticated using ((select auth.uid()) = user_id);
revoke update, truncate on public.session_items from anon, authenticated;

-- subscriptions
alter table public.subscriptions enable row level security;
drop policy if exists own_rows_subscriptions on public.subscriptions;
drop policy if exists own_select_subscriptions on public.subscriptions;
drop policy if exists own_insert_subscriptions on public.subscriptions;
drop policy if exists own_update_subscriptions on public.subscriptions;
drop policy if exists own_delete_subscriptions on public.subscriptions;
create policy own_select_subscriptions on public.subscriptions for select to authenticated using ((select auth.uid()) = user_id);
create policy own_delete_subscriptions on public.subscriptions for delete to authenticated using ((select auth.uid()) = user_id);
revoke update, truncate on public.subscriptions from anon, authenticated;

-- taxonomy_nodes
alter table public.taxonomy_nodes enable row level security;
drop policy if exists own_rows_taxonomy_nodes on public.taxonomy_nodes;
drop policy if exists own_select_taxonomy_nodes on public.taxonomy_nodes;
drop policy if exists own_insert_taxonomy_nodes on public.taxonomy_nodes;
drop policy if exists own_update_taxonomy_nodes on public.taxonomy_nodes;
drop policy if exists own_delete_taxonomy_nodes on public.taxonomy_nodes;
create policy own_select_taxonomy_nodes on public.taxonomy_nodes for select to authenticated using ((select auth.uid()) = user_id);
create policy own_delete_taxonomy_nodes on public.taxonomy_nodes for delete to authenticated using ((select auth.uid()) = user_id);
revoke update, truncate on public.taxonomy_nodes from anon, authenticated;

-- learning_cursor
alter table public.learning_cursor enable row level security;
drop policy if exists own_rows_learning_cursor on public.learning_cursor;
drop policy if exists own_select_learning_cursor on public.learning_cursor;
drop policy if exists own_insert_learning_cursor on public.learning_cursor;
drop policy if exists own_update_learning_cursor on public.learning_cursor;
drop policy if exists own_delete_learning_cursor on public.learning_cursor;
create policy own_select_learning_cursor on public.learning_cursor for select to authenticated using ((select auth.uid()) = user_id);
create policy own_delete_learning_cursor on public.learning_cursor for delete to authenticated using ((select auth.uid()) = user_id);
revoke update, truncate on public.learning_cursor from anon, authenticated;

-- app_users
alter table public.app_users enable row level security;
drop policy if exists own_rows_app_users on public.app_users;
drop policy if exists own_select_app_users on public.app_users;
drop policy if exists own_insert_app_users on public.app_users;
drop policy if exists own_update_app_users on public.app_users;
drop policy if exists own_delete_app_users on public.app_users;
create policy own_select_app_users on public.app_users for select to authenticated using ((select auth.uid()) = user_id);
create policy own_delete_app_users on public.app_users for delete to authenticated using ((select auth.uid()) = user_id);
revoke update, truncate on public.app_users from anon, authenticated;

-- 4. events.ts is set by the server, never by the client (backend-rest-5).
--    The client sends device time; one row stamped in the future (a forged
--    row, or a phone whose clock runs ahead) moved the learning cursor past
--    every real event and froze learning for that user for good.
--    clock_timestamp(), not now(): now() is the transaction start, so every
--    row of one batched POST would share a timestamp and the (ts, id) cursor
--    would reorder them by random uuid. clock_timestamp() advances per row,
--    in the order the client sent them.
create or replace function public.events_force_server_ts()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.ts := clock_timestamp();
  return new;
end;
$$;

revoke execute on function public.events_force_server_ts() from anon, authenticated, public;

drop trigger if exists events_force_server_ts on public.events;
create trigger events_force_server_ts
  before insert on public.events
  for each row execute function public.events_force_server_ts();
