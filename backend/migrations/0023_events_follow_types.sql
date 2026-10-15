-- 0023_events_follow_types.sql
-- RV-23 (docs/roadmap/recommender-v1.md D6, issue #1380): widen the events
-- type CHECK for the follow pair the founder named as a feedback signal,
-- 'show_followed' and 'show_unfollowed'. Every type 0009_events.sql allows
-- is kept. backend/src/types/events.ts EventTypeSchema is the TS side;
-- backend/test/events.test.ts reads the last migration that defines this
-- CHECK and asserts it equals the zod enum.
--
-- DARK. Nothing emits either type: app.js is untouched (UI freeze; the
-- toEventRow cases are the parked RV-27) and the privacy wording is the
-- founder's (RV-24, #1163). The completion fields RV-23 adds to 'finished'
-- live in the jsonb payload and need no DDL.
--
-- NOT APPLIED. The founder applies it in the Supabase SQL editor (the
-- HUMAN-ACTIONS #116 pattern; backend/migrations/supabase/README.md).
-- Until then the live CHECK rejects the two new types.
--
-- 0009 declared the CHECK inline on the column, so Postgres named it
-- events_type_check. Idempotent: the drop is `if exists` and the add
-- follows it in the same file.
--
-- 0020 is reserved for shows-search PKG-10 and 0022 for the CH2-05
-- persona_seed CHECK drop (code-health-2.md amendment 5); the migrate CLI
-- applies files in sorted order with no gap check.
--
-- Rollback: re-add 0009's list (no show_followed/show_unfollowed rows may
-- remain, or the add fails).

alter table events drop constraint if exists events_type_check;
alter table events add constraint events_type_check
  check (type in (
    'card_shown','picked','skipped_at','finished',
    'voice_command','thumbs','saved','session_built',
    'session_rated','show_followed','show_unfollowed'
  ));
