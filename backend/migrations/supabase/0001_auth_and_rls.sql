-- supabase/0001_auth_and_rls.sql  (Supabase project only — see README)
-- ADR-0005. Ties Foray's per-user tables to Supabase Auth: an app_users row is
-- created on sign-in (anonymous OR permanent), and Row-Level Security restricts
-- every client to its own rows via auth.uid(). The offline build/enrichment
-- pipeline connects with the service role, which bypasses RLS.
--
-- NOT verified against a live project yet — review before real data lands.

-- 1. Provision an app_users profile row whenever an auth user is created.
--    Supabase sets auth.users.is_anonymous = true for anonymous sign-ins; we
--    mirror it so app logic can tell anonymous from linked accounts.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.app_users (user_id, is_anonymous)
  values (new.id, coalesce(new.is_anonymous, true))
  on conflict (user_id) do nothing;
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- 2. Keep app_users.is_anonymous / linked_* in sync when a user upgrades an
--    anonymous account to a permanent one (email/OAuth added -> is_anonymous
--    flips false on auth.users).
create or replace function public.handle_user_linked()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if old.is_anonymous is distinct from new.is_anonymous and new.is_anonymous = false then
    update public.app_users
      set is_anonymous = false,
          linked_at = coalesce(linked_at, now())
      where user_id = new.id;
  end if;
  return new;
end;
$$;

drop trigger if exists on_auth_user_linked on auth.users;
create trigger on_auth_user_linked
  after update on auth.users
  for each row execute function public.handle_user_linked();

-- 3. Row-Level Security: each client sees only its own rows. Applied to the
--    per-user tables. Catalogue/pipeline tables (shows, episodes,
--    episode_enrichment, cost_events) are written by the service role and are
--    NOT client-exposed yet — enable their RLS deliberately when/if the client
--    reads them live (they may become shared-read). See ADR-0005 → what's next.
do $$
declare t text;
begin
  foreach t in array array[
    'app_users','taxonomy_nodes','user_interests','events',
    'saved_items','sessions','session_items','subscriptions'
  ] loop
    execute format('alter table public.%I enable row level security;', t);
    -- app_users keys on user_id-as-primary-key; the rest carry a user_id column.
    execute format($p$
      create policy %I on public.%I
        for all
        using (auth.uid() = %s)
        with check (auth.uid() = %s);
    $p$,
      'own_rows_' || t, t,
      case when t = 'app_users' then 'user_id' else 'user_id' end,
      case when t = 'app_users' then 'user_id' else 'user_id' end
    );
  end loop;
end;
$$;
