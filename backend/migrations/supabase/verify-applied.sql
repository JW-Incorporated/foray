-- supabase/verify-applied.sql  (Supabase project only -- see README)
-- HUMAN-ACTIONS #116 and issue #798 ("Infrastructure, not checked"): which of
-- these migrations are live? Paste this whole file into the Supabase SQL editor
-- and run it. It answers with one row per migration:
--
--   migration      the file, relative to backend/migrations/
--   applied        yes | partial | no
--   checks_passed  how many of that file's objects were found, e.g. 9/9
--   missing        what was not found, one item per check, '; '-separated
--
-- READ ONLY. Every statement below is a SELECT over the catalog
-- (information_schema, pg_class, pg_policies, pg_trigger, pg_proc,
-- pg_constraint, pg_extension) plus cron.job, which is read only when the
-- pg_cron schema exists. Nothing here writes, so running it twice, or on a
-- project where none of the migrations are applied, is safe.
--
-- Not a migration: it has no number, so nothing applies it "in filename order"
-- with the others, and it changes nothing if someone does.
--
-- How a row reads:
--   * yes      every object the file creates is there.
--   * partial  some are: the file was edited after it ran, or it stopped part
--              way. `missing` names the rest.
--   * no       none of the objects only this file creates are there: the
--              file has not been applied. (0003 also switches on RLS for the
--              per-user tables 0001 already covers, so after 0001 alone 0003
--              reads `no` with a few checks passed, not `partial`.)
-- 0001 and 0002 created `own_rows_<table>` policies that 0003 replaces with
-- `own_select_/own_insert_/own_delete_<table>`. So their policy checks pass on
-- either name, and 0003's checks say whether the old ones were replaced (gone,
-- with another policy on that table in their place).
-- 0004 needs the portable 0017-0019 tables first (gate G2); until then its row
-- reads `no` with "(table missing)" in `missing`.
--
-- test/supabase-verify-applied.test.js keeps this file in step with the
-- migrations: every table, policy, RLS switch, trigger, function, index,
-- extension and cron job they create must have a row below, under the right
-- file, and this file must stay SELECT-only.

with expected(migration, kind, tbl, name, alt) as (
  values
    -- portable 0014: persona-seed values and the generalist default
    ('0014_persona_seed_source.sql', 'check_allows', 'public.taxonomy_nodes', 'taxonomy_nodes_source_check', 'persona-seed'::text),
    ('0014_persona_seed_source.sql', 'check_allows', 'public.user_interests', 'user_interests_reason_check', 'persona_seed'),
    ('0014_persona_seed_source.sql', 'default', 'public.app_users', 'persona_seed', 'generalist'),

    -- portable 0015: the learning job's cursor table
    ('0015_learning_cursor.sql', 'table', 'public.learning_cursor', null, null),

    -- supabase 0001: app_users provisioning triggers, RLS on the per-user tables
    ('supabase/0001_auth_and_rls.sql', 'function', null, 'public.handle_new_user()', null),
    ('supabase/0001_auth_and_rls.sql', 'trigger', 'auth.users', 'on_auth_user_created', null),
    ('supabase/0001_auth_and_rls.sql', 'function', null, 'public.handle_user_linked()', null),
    ('supabase/0001_auth_and_rls.sql', 'trigger', 'auth.users', 'on_auth_user_linked', null),
    ('supabase/0001_auth_and_rls.sql', 'rls', 'public.app_users', null, null),
    ('supabase/0001_auth_and_rls.sql', 'rls', 'public.taxonomy_nodes', null, null),
    ('supabase/0001_auth_and_rls.sql', 'rls', 'public.user_interests', null, null),
    ('supabase/0001_auth_and_rls.sql', 'rls', 'public.events', null, null),
    ('supabase/0001_auth_and_rls.sql', 'rls', 'public.saved_items', null, null),
    ('supabase/0001_auth_and_rls.sql', 'rls', 'public.sessions', null, null),
    ('supabase/0001_auth_and_rls.sql', 'rls', 'public.session_items', null, null),
    ('supabase/0001_auth_and_rls.sql', 'rls', 'public.subscriptions', null, null),
    ('supabase/0001_auth_and_rls.sql', 'policy', 'public.app_users', 'own_rows_app_users', 'own_select_app_users'),
    ('supabase/0001_auth_and_rls.sql', 'policy', 'public.taxonomy_nodes', 'own_rows_taxonomy_nodes', 'own_select_taxonomy_nodes'),
    ('supabase/0001_auth_and_rls.sql', 'policy', 'public.user_interests', 'own_rows_user_interests', 'own_select_user_interests'),
    ('supabase/0001_auth_and_rls.sql', 'policy', 'public.events', 'own_rows_events', 'own_select_events'),
    ('supabase/0001_auth_and_rls.sql', 'policy', 'public.saved_items', 'own_rows_saved_items', 'own_select_saved_items'),
    ('supabase/0001_auth_and_rls.sql', 'policy', 'public.sessions', 'own_rows_sessions', 'own_select_sessions'),
    ('supabase/0001_auth_and_rls.sql', 'policy', 'public.session_items', 'own_rows_session_items', 'own_select_session_items'),
    ('supabase/0001_auth_and_rls.sql', 'policy', 'public.subscriptions', 'own_rows_subscriptions', 'own_select_subscriptions'),

    -- supabase 0002: linter fixes
    ('supabase/0002_linter_findings.sql', 'rls', 'public.schema_migrations', null, null),
    ('supabase/0002_linter_findings.sql', 'rls', 'public.learning_cursor', null, null),
    ('supabase/0002_linter_findings.sql', 'not_client_callable', null, 'public.handle_new_user()', null),
    ('supabase/0002_linter_findings.sql', 'not_client_callable', null, 'public.handle_user_linked()', null),
    ('supabase/0002_linter_findings.sql', 'policy_authenticated', 'public.app_users', 'own_rows_app_users', 'own_select_app_users'),
    ('supabase/0002_linter_findings.sql', 'policy_authenticated', 'public.taxonomy_nodes', 'own_rows_taxonomy_nodes', 'own_select_taxonomy_nodes'),
    ('supabase/0002_linter_findings.sql', 'policy_authenticated', 'public.user_interests', 'own_rows_user_interests', 'own_select_user_interests'),
    ('supabase/0002_linter_findings.sql', 'policy_authenticated', 'public.events', 'own_rows_events', 'own_select_events'),
    ('supabase/0002_linter_findings.sql', 'policy_authenticated', 'public.saved_items', 'own_rows_saved_items', 'own_select_saved_items'),
    ('supabase/0002_linter_findings.sql', 'policy_authenticated', 'public.sessions', 'own_rows_sessions', 'own_select_sessions'),
    ('supabase/0002_linter_findings.sql', 'policy_authenticated', 'public.session_items', 'own_rows_session_items', 'own_select_session_items'),
    ('supabase/0002_linter_findings.sql', 'policy_authenticated', 'public.subscriptions', 'own_rows_subscriptions', 'own_select_subscriptions'),

    -- supabase 0003: least privilege (founder question Q3)
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.catalog_show_episodes', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.catalog_show_episodes', 'public_read_catalog_show_episodes', null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.catalog_show_feed_state', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.catalog_show_feed_state', 'public_read_catalog_show_feed_state', null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.shows', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.episodes', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.episode_enrichment', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.cost_events', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.events', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'policy_absent', 'public.events', 'own_rows_events', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.events', 'own_select_events', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.events', 'own_insert_events', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.events', 'own_delete_events', null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.saved_items', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'policy_absent', 'public.saved_items', 'own_rows_saved_items', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.saved_items', 'own_select_saved_items', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.saved_items', 'own_delete_saved_items', null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.user_interests', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'policy_absent', 'public.user_interests', 'own_rows_user_interests', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.user_interests', 'own_select_user_interests', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.user_interests', 'own_delete_user_interests', null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.sessions', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'policy_absent', 'public.sessions', 'own_rows_sessions', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.sessions', 'own_select_sessions', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.sessions', 'own_delete_sessions', null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.session_items', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'policy_absent', 'public.session_items', 'own_rows_session_items', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.session_items', 'own_select_session_items', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.session_items', 'own_delete_session_items', null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.subscriptions', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'policy_absent', 'public.subscriptions', 'own_rows_subscriptions', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.subscriptions', 'own_select_subscriptions', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.subscriptions', 'own_delete_subscriptions', null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.taxonomy_nodes', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'policy_absent', 'public.taxonomy_nodes', 'own_rows_taxonomy_nodes', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.taxonomy_nodes', 'own_select_taxonomy_nodes', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.taxonomy_nodes', 'own_delete_taxonomy_nodes', null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.learning_cursor', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'policy_absent', 'public.learning_cursor', 'own_rows_learning_cursor', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.learning_cursor', 'own_select_learning_cursor', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.learning_cursor', 'own_delete_learning_cursor', null),
    ('supabase/0003_rls_least_privilege.sql', 'rls', 'public.app_users', null, null),
    ('supabase/0003_rls_least_privilege.sql', 'policy_absent', 'public.app_users', 'own_rows_app_users', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.app_users', 'own_select_app_users', null),
    ('supabase/0003_rls_least_privilege.sql', 'policy', 'public.app_users', 'own_delete_app_users', null),
    ('supabase/0003_rls_least_privilege.sql', 'function', null, 'public.events_force_server_ts()', null),
    ('supabase/0003_rls_least_privilege.sql', 'not_client_callable', null, 'public.events_force_server_ts()', null),
    ('supabase/0003_rls_least_privilege.sql', 'trigger', 'public.events', 'events_force_server_ts', null),

    -- supabase 0004: RLS on the 0017/0018 tables (gate G2)
    ('supabase/0004_rls_shows_catalog.sql', 'rls', 'public.shows_catalog', null, null),
    ('supabase/0004_rls_shows_catalog.sql', 'policy', 'public.shows_catalog', 'public_read_shows_catalog', null),
    ('supabase/0004_rls_shows_catalog.sql', 'rls', 'public.show_id_map', null, null),

    -- supabase 0005: content_reports (the Report sheet)
    ('supabase/0005_content_reports.sql', 'table', 'public.content_reports', null, null),
    ('supabase/0005_content_reports.sql', 'rls', 'public.content_reports', null, null),
    ('supabase/0005_content_reports.sql', 'policy', 'public.content_reports', 'content_reports_insert_own', null),
    ('supabase/0005_content_reports.sql', 'policy', 'public.content_reports', 'content_reports_select_own', null),
    ('supabase/0005_content_reports.sql', 'policy', 'public.content_reports', 'content_reports_delete_own', null),
    ('supabase/0005_content_reports.sql', 'index', null, 'public.content_reports_status_created_at_idx', null),

    -- supabase 0006: 90-day retention jobs (founder ruling HA #13)
    ('supabase/0006_event_retention.sql', 'extension', null, 'pg_cron', null),
    ('supabase/0006_event_retention.sql', 'function', null, 'public.prune_events_older_than_90d()', null),
    ('supabase/0006_event_retention.sql', 'not_client_callable', null, 'public.prune_events_older_than_90d()', null),
    ('supabase/0006_event_retention.sql', 'function', null, 'public.prune_empty_anonymous_users()', null),
    ('supabase/0006_event_retention.sql', 'not_client_callable', null, 'public.prune_empty_anonymous_users()', null),
    ('supabase/0006_event_retention.sql', 'cron_job', null, 'foray-prune-events-90d', null),
    ('supabase/0006_event_retention.sql', 'cron_job', null, 'foray-prune-anon-shells-90d', null)
),
checked as (
  select
    e.*,
    case e.kind
      when 'table' then to_regclass(e.tbl) is not null
      when 'index' then to_regclass(e.name) is not null
      when 'rls' then coalesce((select c.relrowsecurity from pg_class c where c.oid = to_regclass(e.tbl)), false)
      when 'policy' then exists (
        select 1 from pg_policies p
        where p.schemaname || '.' || p.tablename = e.tbl
          and p.policyname in (e.name, coalesce(e.alt, e.name)))
      when 'policy_authenticated' then exists (
        select 1 from pg_policies p
        where p.schemaname || '.' || p.tablename = e.tbl
          and p.policyname in (e.name, coalesce(e.alt, e.name))
          and p.roles = array['authenticated']::name[])
      when 'policy_absent' then not exists (
        select 1 from pg_policies p
        where p.schemaname || '.' || p.tablename = e.tbl
          and p.policyname = e.name)
        and exists (
        select 1 from pg_policies p
        where p.schemaname || '.' || p.tablename = e.tbl
          and p.policyname <> e.name)
      when 'trigger' then exists (
        select 1 from pg_trigger t
        where t.tgrelid = to_regclass(e.tbl)
          and t.tgname = e.name
          and not t.tgisinternal)
      when 'function' then to_regprocedure(e.name) is not null
      when 'not_client_callable' then
        case
          when to_regprocedure(e.name) is null then false
          when to_regrole('anon') is null or to_regrole('authenticated') is null then false
          else not has_function_privilege('anon', to_regprocedure(e.name)::oid, 'execute')
           and not has_function_privilege('authenticated', to_regprocedure(e.name)::oid, 'execute')
        end
      when 'extension' then exists (select 1 from pg_extension x where x.extname = e.name)
      when 'cron_job' then
        case
          when to_regclass('cron.job') is null then false
          else (xpath('/row/n/text()', query_to_xml(
                  format('select count(*) as n from cron.job where jobname = %L and active', e.name),
                  false, true, '')))[1]::text::int > 0
        end
      when 'check_allows' then exists (
        select 1 from pg_constraint k
        where k.conrelid = to_regclass(e.tbl)
          and k.conname = e.name
          and pg_get_constraintdef(k.oid) like '%''' || e.alt || '''%')
      when 'default' then exists (
        select 1 from information_schema.columns col
        where col.table_schema || '.' || col.table_name = e.tbl
          and col.column_name = e.name
          and col.column_default like '%''' || e.alt || '''%')
      else false
    end as ok,
    not exists (
      select 1 from expected o
      where o.migration <> e.migration
        and o.kind = e.kind
        and o.tbl is not distinct from e.tbl
        and o.name is not distinct from e.name) as own
  from expected e
)
select
  migration,
  case
    when bool_and(ok) then 'yes'
    when coalesce(bool_or(ok) filter (where own), false) then 'partial'
    else 'no'
  end as applied,
  (count(*) filter (where ok)) || '/' || count(*) as checks_passed,
  coalesce(string_agg(
    case kind
      when 'table' then 'table ' || tbl
      when 'index' then 'index ' || name
      when 'rls' then 'RLS on ' || tbl
      when 'policy' then 'policy ' || name || coalesce(' (or ' || alt || ')', '') || ' on ' || tbl
      when 'policy_authenticated' then 'policy ' || name || coalesce(' (or ' || alt || ')', '') || ' on ' || tbl || ' to authenticated only'
      when 'policy_absent' then 'old policy ' || name || ' replaced on ' || tbl
      when 'trigger' then 'trigger ' || name || ' on ' || tbl
      when 'function' then 'function ' || name
      when 'not_client_callable' then 'execute on ' || name || ' revoked from anon/authenticated'
      when 'extension' then 'extension ' || name
      when 'cron_job' then 'active cron job ' || name
      when 'check_allows' then 'constraint ' || name || ' allowing ''' || alt || ''' on ' || tbl
      when 'default' then 'default ''' || alt || ''' on ' || tbl || '.' || name
      else kind || ' ' || coalesce(name, tbl)
    end
    || case
         when tbl is not null and kind <> 'table' and to_regclass(tbl) is null then ' (table missing)'
         when kind = 'not_client_callable' and to_regprocedure(name) is null then ' (function missing)'
         else ''
       end,
    '; ') filter (where not ok), '') as missing
from checked
group by migration
order by migration;
