-- 0015_learning_cursor.sql
-- Bookkeeping for the interest-learning job (personalization-and-depth-plan.md
-- Step C). Additive-only, touches no existing table: a per-user high-water
-- mark into `events` so `npm run learn-interests` is idempotent/resumable
-- without rescanning full history each run. Mirrors the schema_migrations
-- bookkeeping pattern already used by cli/migrate.ts.
--
-- (ts, id) rather than just ts, so events sharing the same timestamp at the
-- cursor boundary are neither skipped nor reprocessed.

create table if not exists learning_cursor (
  user_id             uuid primary key,
  last_event_ts       timestamptz not null,
  last_event_id       uuid not null,
  updated_at          timestamptz not null default now()
);
