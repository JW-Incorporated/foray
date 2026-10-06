-- supabase/0006_event_retention.sql  (Supabase project only -- see README)
-- Founder ruling HA #13 (2026-09-30), retention. Builds on 0001-0003; apply
-- after them. It needs neither 0004 (which waits for gate G2) nor 0005.
-- Idempotent: safe to re-run.
--
-- NOT APPLIED TO PRODUCTION BY THIS CHANGE. Applying it to the live Supabase
-- project is a human action (HUMAN-ACTIONS.md #116, the Supabase apply
-- item). Until it is applied, no event row is deleted automatically.
--
-- The rule (privacy-policy.md section 3):
--   * event rows are deleted 90 days after they were recorded (events.ts,
--     which 0003 forces to server time, so a client clock cannot defer it);
--   * derived state (user_interests, taxonomy_nodes, sessions, saved_items,
--     subscriptions, learning_cursor) lives as long as the account -- this job
--     never touches it for a live account;
--   * an anonymous auth.users row that has no events, no linked identity and
--     no derived state, and has not signed in for 90 days, is an empty shell
--     and is pruned. A client cannot delete its own auth user (that needs a
--     service key), so this job is the only thing that ever removes one.
--     That retires HUMAN-ACTIONS.md #14.
--
-- ROLLBACK (stops the jobs; already-deleted rows do not come back):
--   select cron.unschedule('foray-prune-events-90d');
--   select cron.unschedule('foray-prune-anon-shells-90d');
--   drop function if exists public.prune_events_older_than_90d();
--   drop function if exists public.prune_empty_anonymous_users();
--
-- test/supabase-event-retention.test.js pins every clause below.

-- 1. pg_cron. On Supabase this installs into the `extensions` schema; the
--    `cron` schema it creates is what cron.schedule lives in.
create extension if not exists pg_cron;

-- 2. Events: delete every row recorded more than 90 days ago.
--    SECURITY DEFINER because the cron job runs as the postgres role and the
--    table has RLS; pinned search_path so a hostile schema cannot shadow a
--    name. Not callable from the client: the REVOKE below keeps it off
--    /rest/v1/rpc/ (same reason as 0002 section 2).
create or replace function public.prune_events_older_than_90d()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n bigint;
begin
  delete from public.events where ts < now() - interval '90 days';
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.prune_events_older_than_90d() from anon, authenticated, public;

-- 3. Empty anonymous shells: is_anonymous, no events, no linked identity, no
--    derived state, and nothing seen or signed in for 90 days. The per-user
--    public tables carry no foreign key to auth.users (0013 keeps them
--    portable), so the app_users and learning_cursor rows go with it.
create or replace function public.prune_empty_anonymous_users()
returns bigint
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  n bigint;
begin
  with doomed as (
    select u.id
    from auth.users u
    left join public.app_users a on a.user_id = u.id
    where u.is_anonymous
      and u.created_at < now() - interval '90 days'
      and coalesce(u.last_sign_in_at, u.created_at) < now() - interval '90 days'
      and (a.last_seen_at is null or a.last_seen_at < now() - interval '90 days')
      and not exists (select 1 from public.events e where e.user_id = u.id)
      and not exists (select 1 from auth.identities i where i.user_id = u.id)
      and not exists (select 1 from public.user_interests x where x.user_id = u.id)
      and not exists (select 1 from public.taxonomy_nodes x where x.user_id = u.id)
      and not exists (select 1 from public.saved_items x where x.user_id = u.id)
      and not exists (select 1 from public.sessions x where x.user_id = u.id)
      and not exists (select 1 from public.subscriptions x where x.user_id = u.id)
  ),
  gone_cursor as (
    delete from public.learning_cursor c using doomed d where c.user_id = d.id
  ),
  gone_app as (
    delete from public.app_users a using doomed d where a.user_id = d.id
  )
  delete from auth.users u using doomed d where u.id = d.id;
  get diagnostics n = row_count;
  return n;
end;
$$;

revoke execute on function public.prune_empty_anonymous_users() from anon, authenticated, public;

-- 4. Schedule. cron.schedule(name, ...) upserts by job name, so a re-run
--    replaces the job instead of duplicating it. Daily, off the hour, UTC.
--    Events first, so a shell whose last event just aged out is eligible on
--    the next day's run, not before.
select cron.schedule('foray-prune-events-90d', '17 3 * * *', $$select public.prune_events_older_than_90d();$$);
select cron.schedule('foray-prune-anon-shells-90d', '37 3 * * *', $$select public.prune_empty_anonymous_users();$$);
