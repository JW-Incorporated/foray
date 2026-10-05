-- supabase/0005_content_reports.sql  (Supabase project only — see README)
-- PH2-10 (docs/roadmap/listener-forays-sharing.md §3): the table behind the
-- Report sheet, App Store Guideline 1.2's "a mechanism to report offensive
-- content" (docs/curation/ugc-moderation-runbook.md §2). Builds on 0001-0002
-- (auth.users and the authenticated role); it needs nothing from the portable
-- set or from 0003/0004, so it can be applied alone. Idempotent: safe to re-run.
--
-- NOT APPLIED TO PRODUCTION BY THIS CHANGE. HUMAN-ACTIONS #116 carries the
-- apply step (next to 0003, and 0004, which waits on gate G2).
--
-- Who can do what:
--   * a listener's anonymous session (role `authenticated`) can INSERT a report
--     as itself, and DELETE its own reports (Delete my data, PH2-12);
--   * no client can READ a report: there is no client-readable column except
--     `user_id`, and only on the caller's own rows (see "select-own" below);
--   * no client can UPDATE a report: no policy, no grant. A founder triages in
--     the SQL editor, which runs as `postgres` and bypasses RLS;
--   * `anon` (the publishable key with no session) can do nothing.
--
-- WHY THERE IS A SELECT POLICY (a deliberate deviation from the plan, which
-- said "no select policy"). The client deletes its own rows with a FILTERED
-- DELETE: app.js `sbDeleteOwnRows` sends `DELETE /rest/v1/<table>?user_id=eq.<uid>`.
-- Postgres applies a table's SELECT policies to a DELETE whose WHERE reads a
-- column (CREATE POLICY docs, "Policies Applied by Command Type"), and with RLS
-- on and no SELECT policy that check is false for every row. So delete-own
-- alone would make that DELETE match nothing and still answer 204: a "deleted"
-- that deleted nothing, the exact false success 0003 was written to prevent
-- (test/supabase-rls-verbs.test.js: "a filtered DELETE also needs a SELECT
-- policy"). The select-own policy makes the DELETE work; the COLUMN grants
-- below keep the plan's intent that no client can read a report, because the
-- only column a client may select is `user_id`, which it already knows.
-- PostgREST writes with `Prefer: return=minimal` (`RETURNING 1`) read no
-- other column, so insert and delete need nothing more.
--
-- The column grants also stop a client choosing its own `status` (a report
-- filed as 'dismissed' would never reach the daily review), `created_at` or
-- `id`: it may insert exactly user_id, target_kind, target_id, reasons, note.
--
-- Pinned by test/supabase-content-reports.test.js.

create table if not exists public.content_reports (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  created_at  timestamptz not null default now(),
  target_kind text not null check (target_kind in ('foray', 'episode')),
  target_id   text not null check (char_length(target_id) <= 200),
  reasons     text[] not null default '{}',
  note        text check (note is null or char_length(note) <= 280),
  status      text not null default 'open' check (status in ('open', 'actioned', 'dismissed'))
);

alter table public.content_reports enable row level security;

drop policy if exists content_reports_insert_own on public.content_reports;
drop policy if exists content_reports_select_own on public.content_reports;
drop policy if exists content_reports_delete_own on public.content_reports;
create policy content_reports_insert_own on public.content_reports for insert to authenticated with check ((select auth.uid()) = user_id);
create policy content_reports_select_own on public.content_reports for select to authenticated using ((select auth.uid()) = user_id);
create policy content_reports_delete_own on public.content_reports for delete to authenticated using ((select auth.uid()) = user_id);

-- Supabase's default privileges grant every new public table to anon and
-- authenticated in full (including TRUNCATE, which RLS does not filter).
-- Start from nothing and grant back exactly what the client needs.
revoke all on public.content_reports from anon, authenticated;
grant insert (user_id, target_kind, target_id, reasons, note) on public.content_reports to authenticated;
grant select (user_id) on public.content_reports to authenticated;
grant delete on public.content_reports to authenticated;

-- The daily review reads `where status = 'open' order by created_at`.
create index if not exists content_reports_status_created_at_idx on public.content_reports (status, created_at);
