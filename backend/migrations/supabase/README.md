# Supabase-only migrations

These are **not** applied by `npm run migrate` (`migrate.ts` globs only top-level
`migrations/*.sql`, so this subfolder is skipped) — on purpose. They reference
the Supabase `auth` schema (`auth.uid()`, `auth.users`) which does not exist on a
bare local Postgres, and the portable set must keep running locally (ADR-0005,
`0001_extensions.sql`).

Apply these to the **Supabase project** after the portable set, via the project's
SQL editor or a dedicated deploy step, in filename order.

**Status: written to spec, NOT yet verified against a live project.** Review and
test before any real user data lands (ADR-0005 → Risks).

| File | What it does |
|------|--------------|
| `0001_auth_and_rls.sql` | Trigger to create an `app_users` row on (anonymous or permanent) sign-in; enables Row-Level Security + `auth.uid() = user_id` policies on the per-user tables. |
| `0002_linter_findings.sql` | Fixes the Supabase database linter's findings: enables deny-all RLS on `schema_migrations`/`learning_cursor`, revokes `anon`/`authenticated` EXECUTE on the two `SECURITY DEFINER` trigger functions, and rescopes the 8 `own_rows_*` policies `to authenticated` explicitly. |
| `0003_rls_least_privilege.sql` | Round-3 audit (backend-rest-4/-5, data-integrity-10): public read-only RLS on the shared catalogue (`catalog_show_episodes`, `catalog_show_feed_state`); deny-all RLS on the pipeline tables (`shows`, `episodes`, `episode_enrichment`, `cost_events`); splits every `own_rows_*` `for all` policy into per-verb policies (select + delete everywhere, insert on `events` only, update nowhere); adds `learning_cursor` own-rows select + delete so Delete my data reaches it; forces `events.ts` server-side with a BEFORE INSERT trigger. Pinned by `test/supabase-rls-verbs.test.js`. **Not applied to production** (founder Q3). |
| `0004_rls_shows_catalog.sql` | PKG-02 (S-09), PR #1045 review: public read-only RLS on `shows_catalog` (portable 0017); deny-all RLS on `show_id_map` (portable 0018). Apply after 0017-0019, as part of gate G2. `test/supabase-rls-coverage.test.js` fails if a table any portable migration creates has no RLS here. **Not applied to production.** |
