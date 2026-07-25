-- 0014_persona_seed_source.sql
-- Personalization Step A+B (personalization-and-depth-plan.md sec.3a/sec.8):
-- widen the two CHECK constraints that block persona-seeded rows, and make
-- app_users.persona_seed an explicit written default instead of an implicit
-- app-logic assumption (principle #2: state observed, never declared -- a
-- cold-start prior must still be a real, inspectable row, not a silent
-- fallback baked into code).

alter table taxonomy_nodes drop constraint if exists taxonomy_nodes_source_check;
alter table taxonomy_nodes add constraint taxonomy_nodes_source_check
  check (source in ('onboarding-interview','inferred','voice-mutation','manual-edit','persona-seed'));

alter table user_interests drop constraint if exists user_interests_reason_check;
alter table user_interests add constraint user_interests_reason_check
  check (reason in (
    'onboarding','finished_strong','picked_from_menu',
    'skip_strong_neg','skip_weak_neg','more_like_this',
    'something_different','thumbs_down_named_node',
    'saved_for_later','card_ignored_repeatedly','manual_edit','persona_seed'
  ));

-- New users get an explicit, written persona_seed at row creation (matches
-- data/personas.json's default_persona_id) rather than relying on app code
-- to silently assume Generalist for a null column.
alter table app_users alter column persona_seed set default 'generalist';
update app_users set persona_seed = 'generalist' where persona_seed is null;
