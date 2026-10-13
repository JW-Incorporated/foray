-- supabase/0007_generation_jobs.sql  (Supabase project only -- see README)
-- GV-59 (docs/roadmap/generation-v2.md, #1286; from W6-18; D9): the job row.
-- An author asks for a Foray; the Spark worker (GV-105) claims the job, runs
-- generation and rewrites the row's snapshot (GV-44's foray-job/1 document)
-- as items become servable; the phone polls its own row. Builds on 0001-0002
-- (auth.users and the authenticated role) and nothing else, so it can be
-- applied alone. Idempotent: safe to re-run.
--
-- NOT APPLIED TO PRODUCTION BY THIS CHANGE. Applying it is the founder's step
-- (GV-59 live step; Founder queue item 9 in docs/roadmap/generation-v2.md).
-- Until it is applied nothing reads or writes these tables, and nothing in
-- the repo constructs the sink that would (backend/src/cli/supabaseJobSink.ts
-- is built only by the GV-105 worker).
--
-- Who can do what:
--   * an author (role `authenticated`) listed in generation_job_authors may
--     INSERT a queued on-demand job as itself (D9: founders first). It may
--     write only author_id, tier and prompt; every other column takes its
--     default, and the insert policy re-checks them;
--   * an author may SELECT its own rows, but never the prompt column (it is
--     held for the worker only) nor the worker's name;
--   * an author may UPDATE exactly one column, status, and only from an open
--     state (queued, claimed, running) to 'cancelled'. It cannot DELETE;
--   * `anon` (the publishable key with no session) can do nothing;
--   * the worker connects with the service-role key (D8), which bypasses RLS,
--     and takes jobs only through claim_generation_job.
--
-- THE PROMPT IS HELD ONLY UNTIL A WORKER CLAIMS THE JOB (generation-v2 §9.4,
-- RQ-04). claim_generation_job returns the prompt and NULLs it in the same
-- UPDATE; the before-update trigger NULLs it on any move out of 'queued'
-- (claim, cancel, fail); and a CHECK makes a prompt on a non-queued row
-- impossible. Whether holding it until claim satisfies the privacy policy is
-- the founder's call (#1163); docs/legal is not touched here.
--
-- DELETION. author_id references auth.users(id) ON DELETE CASCADE, so
-- deleting an account removes its jobs (and its allowlist row) on the server.
-- app.js's SB_USER_TABLES (Delete my data) is UI-frozen, which is why the
-- owner column is author_id and not user_id: no client path writes this table
-- yet (test/data-deletion.test.js holds that ledger).
--
-- ROLLBACK (drops every job; there is nothing to recover):
--   drop table if exists public.generation_jobs;
--   drop table if exists public.generation_job_authors;
--   drop function if exists public.claim_generation_job(text);
--   drop function if exists public.generation_jobs_before_update();
--
-- Pinned by test/supabase-rls-coverage.test.js, test/supabase-rls-verbs.test.js,
-- test/supabase-verify-applied.test.js and test/data-deletion.test.js.

-- 1. The founder allowlist (D9: founders first). A founder adds a row in the
--    SQL editor (`insert into public.generation_job_authors (author_id)
--    values ('<auth uid>');`), which runs as postgres. A client may read only
--    its own row's author_id: the insert policy below asks "am I listed?",
--    and a policy's subquery runs with the caller's rights.
create table if not exists public.generation_job_authors (
  author_id  uuid primary key references auth.users(id) on delete cascade,
  added_at   timestamptz not null default now(),
  note       text check (note is null or char_length(note) <= 200)
);

alter table public.generation_job_authors enable row level security;

drop policy if exists generation_job_authors_select_own on public.generation_job_authors;
create policy generation_job_authors_select_own on public.generation_job_authors for select to authenticated using ((select auth.uid()) = author_id);

revoke all on public.generation_job_authors from anon, authenticated;
grant select (author_id) on public.generation_job_authors to authenticated;

-- 2. The job row.
create table if not exists public.generation_jobs (
  id          uuid primary key default gen_random_uuid(),
  author_id   uuid not null references auth.users(id) on delete cascade,
  status      text not null default 'queued' check (status in ('queued', 'claimed', 'running', 'complete', 'failed', 'cancelled')),
  tier        text not null check (tier in ('short', 'medium', 'long')),
  lane        text not null default 'on-demand' check (lane in ('on-demand', 'catalogue')),
  prompt      text check (prompt is null or char_length(prompt) <= 2000),
  snapshot    jsonb,
  seq         integer not null default 0 check (seq >= 0),
  created_at  timestamptz not null default now(),
  claimed_at  timestamptz,
  updated_at  timestamptz not null default now(),
  worker      text check (worker is null or char_length(worker) <= 120),
  constraint generation_jobs_prompt_only_while_queued check (prompt is null or status = 'queued')
);

alter table public.generation_jobs enable row level security;

drop policy if exists generation_jobs_select_own on public.generation_jobs;
drop policy if exists generation_jobs_insert_allowlisted on public.generation_jobs;
drop policy if exists generation_jobs_cancel_own on public.generation_jobs;
create policy generation_jobs_select_own on public.generation_jobs for select to authenticated using ((select auth.uid()) = author_id);
create policy generation_jobs_insert_allowlisted on public.generation_jobs for insert to authenticated with check (
  (select auth.uid()) = author_id
  and status = 'queued'
  and lane = 'on-demand'
  and seq = 0
  and snapshot is null
  and claimed_at is null
  and worker is null
  and exists (select 1 from public.generation_job_authors a where a.author_id = (select auth.uid()))
);
create policy generation_jobs_cancel_own on public.generation_jobs for update to authenticated using (
  (select auth.uid()) = author_id and status in ('queued', 'claimed', 'running')
) with check (
  (select auth.uid()) = author_id and status = 'cancelled'
);

-- Supabase's default privileges grant every new public table to anon and
-- authenticated in full (TRUNCATE included, which RLS does not filter).
-- Start from nothing and grant back exactly what an author needs. No column
-- grant names prompt or worker for select, and none names anything but
-- status for update.
revoke all on public.generation_jobs from anon, authenticated;
grant insert (author_id, tier, prompt) on public.generation_jobs to authenticated;
grant select (id, author_id, status, tier, lane, snapshot, seq, created_at, claimed_at, updated_at) on public.generation_jobs to authenticated;
grant update (status) on public.generation_jobs to authenticated;

-- 3. Every update stamps updated_at, and a row leaving 'queued' drops its
--    prompt, whoever moves it. Not SECURITY DEFINER: it only edits NEW.
create or replace function public.generation_jobs_before_update()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  new.updated_at := now();
  if new.status <> 'queued' then
    new.prompt := null;
  end if;
  return new;
end;
$$;

revoke execute on function public.generation_jobs_before_update() from anon, authenticated, public;

drop trigger if exists generation_jobs_before_update on public.generation_jobs;
create trigger generation_jobs_before_update
  before update on public.generation_jobs
  for each row execute function public.generation_jobs_before_update();

-- 4. The claim. One statement: lock the oldest queued job (on-demand first,
--    OQ-07 "Foray first in line") with SKIP LOCKED so two workers never take
--    the same row, mark it claimed, NULL its prompt, and return the prompt it
--    held. The prompt leaves the table in the same statement that hands it
--    over. SECURITY DEFINER with a pinned search_path; callable only by the
--    service role (the Spark worker), never from /rest/v1/rpc/ by a client.
create or replace function public.claim_generation_job(p_worker text)
returns table (id uuid, author_id uuid, tier text, lane text, prompt text)
language sql
security definer
set search_path = public, pg_temp
as $$
  with picked as (
    select j.id, j.prompt
    from public.generation_jobs j
    where j.status = 'queued'
      and p_worker is not null
      and char_length(p_worker) between 1 and 120
    order by (j.lane = 'on-demand') desc, j.created_at, j.id
    limit 1
    for update skip locked
  )
  update public.generation_jobs g
  set status = 'claimed',
      prompt = null,
      claimed_at = now(),
      worker = p_worker
  from picked
  where g.id = picked.id
  returning g.id, g.author_id, g.tier, g.lane, picked.prompt;
$$;

revoke execute on function public.claim_generation_job(text) from anon, authenticated, public;
grant execute on function public.claim_generation_job(text) to service_role;

-- 5. The worker's queue scan and the phone's poll of its own rows.
create index if not exists generation_jobs_queued_idx on public.generation_jobs (lane, created_at) where status = 'queued';
create index if not exists generation_jobs_author_created_at_idx on public.generation_jobs (author_id, created_at);
