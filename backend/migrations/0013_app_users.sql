-- 0013_app_users.sql
-- The owning identity row that was missing: every other table carries user_id
-- (hard constraint #7) but nothing defined the user. This is app-level profile
-- state that does NOT belong in Supabase's auth.users. See ADR-0005.
--
-- On Supabase, `user_id` equals `auth.uid()` and a row is created on anonymous
-- sign-in by the trigger in migrations/supabase/. Kept portable to bare local
-- Postgres (no FK to the auth schema, no auth.uid() default) so `npm run
-- migrate` still runs without Supabase, consistent with 0001_extensions.sql.

create table if not exists app_users (
  user_id            uuid primary key default gen_random_uuid(),

  -- Identity lifecycle (ADR-0005: anonymous-first, opt-in accounts).
  is_anonymous       boolean not null default true,   -- flips false on account link
  linked_provider    text check (linked_provider is null or linked_provider in
                        ('email','apple','google')),   -- how they upgraded, if they did
  linked_at          timestamptz,

  -- Cold-start seed (personalization plan §3a): the persona a new user starts on
  -- before any observed behavior. Null until personas ship; defaults to the
  -- Generalist persona in app logic, never asked (principle #2).
  persona_seed       text,

  -- Onboarding progress. Onboarding may only set decaying priors, never facts
  -- (ADR intent + principle #2); this just records whether the optional chip
  -- screen was shown/skipped so we don't re-nag.
  onboarding_state   text not null default 'pending'
                       check (onboarding_state in ('pending','skipped','completed')),

  created_at         timestamptz not null default now(),
  last_seen_at       timestamptz,

  -- Self-serve data deletion (legally-boring / privacy posture). Soft-delete
  -- marker; a retention job hard-deletes the user's rows across tables.
  deleted_at         timestamptz
);

create index if not exists idx_app_users_anon_stale
  on app_users (is_anonymous, last_seen_at)
  where is_anonymous;   -- supports pruning abandoned anonymous first-runs
