-- supabase/0002_linter_findings.sql  (Supabase project only — see README)
-- Fixes the Supabase database linter's 2 ERRORs + 14 WARNs (kanban t_58c99c73,
-- founder-approved spec on the card). Builds on 0001_auth_and_rls.sql; apply
-- after it, in filename order.

-- 1. Enable RLS on the two tables the linter flagged as exposed via
--    PostgREST with no RLS (the 2 ERRORs). Neither table is read by any
--    frontend/edge code with the anon or authenticated key (both are
--    backend/CLI-only bookkeeping — cli/migrate.ts and the interest-learning
--    job, both service-role connections which bypass RLS regardless).
--    Deny-all is correct: no policies needed, migrations/workers unaffected.
alter table public.schema_migrations enable row level security;
alter table public.learning_cursor enable row level security;

-- 2. Revoke public EXECUTE on the two SECURITY DEFINER auth-trigger
--    functions (4 WARNs). They must only fire from their `on_auth_user_*`
--    triggers (which run as the function owner, unaffected by REVOKE) —
--    not be callable directly at /rest/v1/rpc/... by anon/authenticated.
revoke execute on function public.handle_new_user() from anon, authenticated, public;
revoke execute on function public.handle_user_linked() from anon, authenticated, public;

-- 3. Scope the 8 own_rows_* policies from 0001 explicitly `to authenticated`
--    (9 WARNs; low real risk since anon has no auth.uid() and matches zero
--    rows either way, but the linter wants explicit intent). Recreated
--    rather than altered since `alter policy` cannot add a TO clause to a
--    policy that has none. Also wraps `auth.uid()` as `(select auth.uid())`
--    so Postgres evaluates it once (an initplan) instead of once per row —
--    same result, but avoids the linter's separate `auth_rls_initplan`
--    performance WARN and repeated re-evaluation on large tables.
--
--    Note on the linter's 9th related WARN, an `own_rows_sessions` policy
--    it associates with `auth.sessions`: this repo has never created any
--    policy on Supabase's managed `auth.sessions` table (confirmed: no
--    `auth.sessions` reference anywhere in the codebase). The only
--    `own_rows_sessions` policy that exists is the one below, on
--    `public.sessions`, created by the loop in 0001. Left as-is; nothing to
--    remove.
do $$
declare t text;
begin
  foreach t in array array[
    'app_users','taxonomy_nodes','user_interests','events',
    'saved_items','sessions','session_items','subscriptions'
  ] loop
    execute format('drop policy if exists %I on public.%I;', 'own_rows_' || t, t);
    execute format($p$
      create policy %I on public.%I
        for all
        to authenticated
        using ((select auth.uid()) = %s)
        with check ((select auth.uid()) = %s);
    $p$,
      'own_rows_' || t, t,
      'user_id',
      'user_id'
    );
  end loop;
end;
$$;
